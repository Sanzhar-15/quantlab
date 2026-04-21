"""
Structured logging module.

Provides:
- JSON Lines log format
- Log rotation with configurable retention
- Audit log (append-only, 7-year retention, tamper-evident)
- Context-aware logging
- Sensitive data redaction

Log Files:
    - app.log: UI events (10MB × 5 files, 7 days)
    - engine.log: Engine events (50MB × 10 files, 30 days)
    - daemon.log: Per-session daemon (50MB × 5 files, 90 days)
    - audit.log: Trading actions (never rotated, 7 years)

Spec Reference: Technical Spec §13.3, Decision N87
"""

from .audit import AuditAction
from .audit import AuditEntry
from .audit import AuditLog
from .audit import audit_order_cancel
from .audit import audit_order_fill
from .audit import audit_order_modify
from .audit import audit_order_submit
from .audit import audit_position_adjust
from .audit import audit_position_close
from .audit import audit_position_open
from .audit import audit_risk_override
from .audit import audit_session_start
from .config import ContextAdapter
from .config import JsonFormatter
from .config import LogConfig
from .config import SecureFilter
from .config import cleanup_old_logs
from .config import get_logger
from .config import setup_logging
from .config import DEFAULT_LOG_DIR
from .config import LOG_CONFIGS

__all__ = [
    # Configuration
    "setup_logging",
    "get_logger",
    "cleanup_old_logs",
    "LogConfig",
    "LOG_CONFIGS",
    "DEFAULT_LOG_DIR",
    # Formatters and Filters
    "JsonFormatter",
    "ContextAdapter",
    "SecureFilter",
    # Audit Log
    "AuditLog",
    "AuditEntry",
    "AuditAction",
    # Audit Helpers
    "audit_order_submit",
    "audit_order_modify",
    "audit_order_cancel",
    "audit_order_fill",
    "audit_session_start",
    "audit_risk_override",
    "audit_position_open",
    "audit_position_close",
    "audit_position_adjust",
]
