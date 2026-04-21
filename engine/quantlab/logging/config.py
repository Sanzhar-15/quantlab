"""
Logging Configuration.

Provides structured JSON logging with rotation and retention policies.

Log Files:
    - app.log: UI events (10MB × 5 files, 7 days)
    - engine.log: Engine events (50MB × 10 files, 30 days)
    - daemon.log: Per-session daemon (50MB × 5 files, 90 days)
    - audit.log: Trading actions (never rotated, 7 years)

Spec Reference: Technical Spec §13.3, Decision N87
"""

import json
import logging
import os
import sys
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any


# Log directory
DEFAULT_LOG_DIR = Path.home() / ".quantlab" / "logs"


@dataclass
class LogConfig:
    """Configuration for a log file."""

    name: str
    filename: str
    max_bytes: int
    backup_count: int
    retention_days: int
    level: int = logging.INFO

    @property
    def max_mb(self) -> int:
        """Max size in MB."""
        return self.max_bytes // (1024 * 1024)


# Standard log configurations
LOG_CONFIGS = {
    "app": LogConfig(
        name="app",
        filename="app.log",
        max_bytes=10 * 1024 * 1024,  # 10 MB
        backup_count=5,
        retention_days=7,
    ),
    "engine": LogConfig(
        name="engine",
        filename="engine.log",
        max_bytes=50 * 1024 * 1024,  # 50 MB
        backup_count=10,
        retention_days=30,
    ),
    "daemon": LogConfig(
        name="daemon",
        filename="daemon.log",
        max_bytes=50 * 1024 * 1024,  # 50 MB
        backup_count=5,
        retention_days=90,
    ),
}


class JsonFormatter(logging.Formatter):
    """
    JSON Lines log formatter.

    Output format:
        {"timestamp": "2026-01-26T14:30:00Z", "level": "INFO", "logger": "daemon",
         "message": "Order submitted", "context": {"order_id": "ord-123"}}
    """

    def __init__(
        self,
        include_exc_info: bool = True,
        include_stack_info: bool = False,
    ) -> None:
        super().__init__()
        self._include_exc_info = include_exc_info
        self._include_stack_info = include_stack_info

    def format(self, record: logging.LogRecord) -> str:
        """Format log record as JSON."""
        # Base log entry
        log_entry: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "+00:00",
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        # Add context if present
        if hasattr(record, "context") and record.context:
            log_entry["context"] = record.context

        # Add source location for DEBUG
        if record.levelno <= logging.DEBUG:
            log_entry["source"] = {
                "file": record.filename,
                "line": record.lineno,
                "function": record.funcName,
            }

        # Add exception info
        if self._include_exc_info and record.exc_info:
            log_entry["exception"] = self.formatException(record.exc_info)

        # Add stack info
        if self._include_stack_info and record.stack_info:
            log_entry["stack"] = record.stack_info

        return json.dumps(log_entry, default=str)


class ContextAdapter(logging.LoggerAdapter):
    """
    Logger adapter that adds context to log records.

    Usage:
        logger = get_logger(__name__)
        logger = logger.with_context(session_id="abc", order_id="ord-123")
        logger.info("Processing order")
    """

    def __init__(
        self,
        logger: logging.Logger,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(logger, extra or {})

    def process(
        self,
        msg: str,
        kwargs: dict[str, Any],
    ) -> tuple[str, dict[str, Any]]:
        """Add context to log record."""
        # Merge extra context
        extra = kwargs.get("extra", {})
        context = {**self.extra, **extra.get("context", {})}

        if context:
            kwargs["extra"] = {**extra, "context": context}

        return msg, kwargs

    def with_context(self, **kwargs: Any) -> "ContextAdapter":
        """Create new adapter with additional context."""
        merged = {**self.extra, **kwargs}
        return ContextAdapter(self.logger, merged)


class SecureFilter(logging.Filter):
    """
    Filter to prevent sensitive data from appearing in logs.

    Redacts:
    - API keys
    - Passwords
    - Tokens
    - Account numbers
    """

    SENSITIVE_PATTERNS = [
        "password",
        "secret",
        "token",
        "api_key",
        "apikey",
        "api-key",
        "auth",
        "credential",
        "account_number",
        "ssn",
    ]

    def filter(self, record: logging.LogRecord) -> bool:
        """Filter and redact sensitive data."""
        # Redact message
        record.msg = self._redact_string(str(record.msg))

        # Redact args
        if record.args:
            record.args = tuple(
                self._redact_string(str(arg)) if isinstance(arg, str) else arg
                for arg in record.args
            )

        # Redact context
        if hasattr(record, "context") and isinstance(record.context, dict):
            record.context = self._redact_dict(record.context)

        return True

    def _redact_string(self, s: str) -> str:
        """Redact sensitive patterns from string.

        Handles common formats:
        - key=value
        - key: value
        - "key": "value"
        - key='value'
        """
        import re

        result = s
        lower = s.lower()

        for pattern in self.SENSITIVE_PATTERNS:
            if pattern in lower:
                # Pattern: key=value or key='value' or key="value"
                regex = re.compile(
                    rf'({pattern}\s*[=:]\s*)(["\']?)([^"\'\s,\}}]+)\2',
                    re.IGNORECASE
                )
                result = regex.sub(r'\1\2[REDACTED]\2', result)

                # Pattern: "key": "value" (JSON style)
                json_regex = re.compile(
                    rf'("{pattern}":\s*)("[^"]*")',
                    re.IGNORECASE
                )
                result = json_regex.sub(r'\1"[REDACTED]"', result)

        return result

    def _redact_dict(self, d: dict[str, Any]) -> dict[str, Any]:
        """Redact sensitive keys from dictionary."""
        result = {}
        for key, value in d.items():
            lower_key = key.lower()
            if any(p in lower_key for p in self.SENSITIVE_PATTERNS):
                result[key] = "[REDACTED]"
            elif isinstance(value, dict):
                result[key] = self._redact_dict(value)
            else:
                result[key] = value
        return result


def setup_logging(
    log_dir: Path | None = None,
    level: int = logging.INFO,
    json_format: bool = True,
    console: bool = True,
    session_id: str | None = None,
) -> None:
    """
    Configure logging for the application.

    Args:
        log_dir: Directory for log files
        level: Minimum log level
        json_format: Use JSON formatting
        console: Output to console as well
        session_id: Session ID for daemon logs
    """
    log_dir = log_dir or DEFAULT_LOG_DIR
    log_dir.mkdir(parents=True, exist_ok=True)

    # Get root logger
    root = logging.getLogger()
    root.setLevel(level)

    # Clear existing handlers
    root.handlers.clear()

    # Create formatter
    if json_format:
        formatter = JsonFormatter()
    else:
        formatter = logging.Formatter(
            "%(asctime)s %(levelname)s [%(name)s] %(message)s"
        )

    # Add secure filter
    secure_filter = SecureFilter()

    # Setup app log (UI events)
    app_config = LOG_CONFIGS["app"]
    app_handler = RotatingFileHandler(
        log_dir / app_config.filename,
        maxBytes=app_config.max_bytes,
        backupCount=app_config.backup_count,
    )
    app_handler.setFormatter(formatter)
    app_handler.addFilter(secure_filter)
    app_handler.setLevel(app_config.level)
    # Attach to quantlab.app logger namespace
    app_logger = logging.getLogger("quantlab.app")
    app_logger.addHandler(app_handler)

    # Setup engine log
    engine_config = LOG_CONFIGS["engine"]
    engine_handler = RotatingFileHandler(
        log_dir / engine_config.filename,
        maxBytes=engine_config.max_bytes,
        backupCount=engine_config.backup_count,
    )
    engine_handler.setFormatter(formatter)
    engine_handler.addFilter(secure_filter)
    root.addHandler(engine_handler)

    # Setup daemon log if session_id provided
    if session_id:
        daemon_config = LOG_CONFIGS["daemon"]
        daemon_handler = RotatingFileHandler(
            log_dir / f"daemon_{session_id}.log",
            maxBytes=daemon_config.max_bytes,
            backupCount=daemon_config.backup_count,
        )
        daemon_handler.setFormatter(formatter)
        daemon_handler.addFilter(secure_filter)

        daemon_logger = logging.getLogger("quantlab.daemon")
        daemon_logger.addHandler(daemon_handler)

    # Console handler
    if console:
        console_handler = logging.StreamHandler(sys.stderr)
        console_handler.setFormatter(formatter)
        console_handler.addFilter(secure_filter)
        root.addHandler(console_handler)


def get_logger(name: str) -> ContextAdapter:
    """
    Get a logger with context support.

    Args:
        name: Logger name (typically __name__)

    Returns:
        Context-aware logger adapter
    """
    logger = logging.getLogger(name)
    return ContextAdapter(logger)


def cleanup_old_logs(
    log_dir: Path | None = None,
    max_age_days: int | None = None,
) -> int:
    """
    Clean up old log files based on retention policy.

    Args:
        log_dir: Directory containing logs
        max_age_days: Override retention days

    Returns:
        Number of files deleted
    """
    log_dir = log_dir or DEFAULT_LOG_DIR
    if not log_dir.exists():
        return 0

    deleted = 0
    now = datetime.now()

    for config in LOG_CONFIGS.values():
        retention = max_age_days or config.retention_days
        cutoff = now.timestamp() - (retention * 24 * 60 * 60)

        pattern = f"{config.filename}*"
        for log_file in log_dir.glob(pattern):
            if log_file.stat().st_mtime < cutoff:
                try:
                    log_file.unlink()
                    deleted += 1
                except OSError:
                    pass

    return deleted
