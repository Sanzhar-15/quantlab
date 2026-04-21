"""
Audit logging module.

Provides:
- Append-only tamper-evident ledger (§12.1, §12.3)
- CRC32 per entry for integrity
- Hash chaining for tamper evidence
- 7-year retention compliance
- Session recovery utilities

Spec Reference: Technical Spec §12
"""

from .ledger import CRITICAL_ENTRY_TYPES
from .ledger import AuditLedger
from .ledger import EntryType
from .ledger import LedgerEntry
from .ledger import log_error
from .ledger import log_order_cancel
from .ledger import log_order_fill
from .ledger import log_order_reject
from .ledger import log_order_submit
from .ledger import log_position_snapshot
from .ledger import log_session_end
from .ledger import log_session_start
from .recovery import RecoveredOrder
from .recovery import RecoveredPosition
from .recovery import SessionRecoveryResult
from .recovery import cleanup_old_ledgers
from .recovery import list_recoverable_sessions
from .recovery import recover_session

__all__ = [
    # Entry types
    "EntryType",
    "CRITICAL_ENTRY_TYPES",
    # Ledger
    "LedgerEntry",
    "AuditLedger",
    # Logging functions
    "log_session_start",
    "log_session_end",
    "log_order_submit",
    "log_order_fill",
    "log_order_cancel",
    "log_order_reject",
    "log_position_snapshot",
    "log_error",
    # Recovery
    "RecoveredPosition",
    "RecoveredOrder",
    "SessionRecoveryResult",
    "recover_session",
    "list_recoverable_sessions",
    "cleanup_old_ledgers",
]
