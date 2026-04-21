"""
Audit Log for Trading Actions.

Provides append-only, tamper-evident logging for compliance.

Features:
- Never rotated (7 year retention required)
- Each entry includes hash of previous entry
- JSON Lines format
- Cryptographic integrity verification

Audit Events:
- Order submission
- Order cancellation
- Order modification
- Position open/close
- Risk limit changes
- Session start/stop
- Manual overrides

Spec Reference: Technical Spec §13.3, Decision N87
"""

import hashlib
import gzip
import json
import logging
import os
import shutil
import threading
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from enum import Enum
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)


# Audit log location
DEFAULT_AUDIT_PATH = Path.home() / ".quantlab" / "logs" / "audit.log"
DEFAULT_ARCHIVE_PATH = Path.home() / ".quantlab" / "logs" / "archive"

# Retention policy per Technical Spec §13.3
RETENTION_YEARS = 7
RETENTION_DAYS = RETENTION_YEARS * 365

# Archive settings
ARCHIVE_AFTER_DAYS = 30  # Compress logs older than 30 days


class AuditAction(Enum):
    """Audit event action types."""

    # Orders
    ORDER_SUBMIT = "order.submit"
    ORDER_CANCEL = "order.cancel"
    ORDER_MODIFY = "order.modify"
    ORDER_FILL = "order.fill"
    ORDER_REJECT = "order.reject"

    # Positions
    POSITION_OPEN = "position.open"
    POSITION_CLOSE = "position.close"
    POSITION_ADJUST = "position.adjust"

    # Risk
    RISK_LIMIT_CHANGE = "risk.limit_change"
    RISK_OVERRIDE = "risk.override"
    CIRCUIT_BREAKER_TRIP = "risk.circuit_breaker_trip"
    CIRCUIT_BREAKER_RESET = "risk.circuit_breaker_reset"

    # Session
    SESSION_START = "session.start"
    SESSION_STOP = "session.stop"
    SESSION_PAUSE = "session.pause"
    SESSION_RESUME = "session.resume"

    # System
    DAEMON_START = "daemon.start"
    DAEMON_STOP = "daemon.stop"
    CONFIG_CHANGE = "config.change"
    MANUAL_OVERRIDE = "manual.override"


@dataclass
class AuditEntry:
    """Single audit log entry."""

    sequence: int
    timestamp: datetime
    action: AuditAction
    session_id: str
    user_id: str | None
    data: dict[str, Any] = field(default_factory=dict)
    previous_hash: str = ""
    entry_hash: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "seq": self.sequence,
            "ts": self.timestamp.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "action": self.action.value,
            "session_id": self.session_id,
            "user_id": self.user_id,
            "data": self.data,
            "prev_hash": self.previous_hash,
            "hash": self.entry_hash,
        }

    def compute_hash(self) -> str:
        """Compute SHA256 hash of this entry (excluding entry_hash field).

        Uses SHA256 per Technical Spec §13.3, Decision N87 for tamper-evident
        compliance logging. Returns 64-character hex string (256-bit hash).
        """
        hash_input = {
            "seq": self.sequence,
            "ts": self.timestamp.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "action": self.action.value,
            "session_id": self.session_id,
            "user_id": self.user_id,
            "data": self.data,
            "prev_hash": self.previous_hash,
        }
        content = json.dumps(hash_input, sort_keys=True, default=str)
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    def compute_hash_legacy_crc32(self) -> str:
        """Compute CRC32 hash for backward compatibility with pre-v10 logs.

        Returns 8-character hex string (32-bit CRC).
        Used only for verifying old audit logs.
        """
        import binascii

        hash_input = {
            "seq": self.sequence,
            "ts": self.timestamp.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "action": self.action.value,
            "session_id": self.session_id,
            "user_id": self.user_id,
            "data": self.data,
            "prev_hash": self.previous_hash,
        }
        content = json.dumps(hash_input, sort_keys=True, default=str)
        crc = binascii.crc32(content.encode("utf-8")) & 0xffffffff
        return f"{crc:08x}"

    def verify_hash(self) -> bool:
        """Verify the entry hash using appropriate algorithm.

        Detects algorithm by hash length:
        - 8 chars = CRC32 (legacy)
        - 64 chars = SHA256 (current)
        """
        if len(self.entry_hash) == 8:
            return self.entry_hash == self.compute_hash_legacy_crc32()
        elif len(self.entry_hash) == 64:
            return self.entry_hash == self.compute_hash()
        else:
            return False  # Unknown hash format

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AuditEntry":
        """Create from dictionary."""
        return cls(
            sequence=data["seq"],
            timestamp=datetime.fromisoformat(data["ts"].replace("Z", "+00:00")),
            action=AuditAction(data["action"]),
            session_id=data["session_id"],
            user_id=data.get("user_id"),
            data=data.get("data", {}),
            previous_hash=data.get("prev_hash", ""),
            entry_hash=data.get("hash", ""),
        )


class AuditLog:
    """
    Append-only audit log.

    Thread-safe. Each entry includes a hash of the previous entry
    to create a tamper-evident chain.
    """

    def __init__(self, path: Path | None = None) -> None:
        """
        Initialize audit log.

        Args:
            path: Path to audit log file
        """
        self._path = path or DEFAULT_AUDIT_PATH
        self._lock = threading.Lock()
        self._sequence = 0
        self._last_hash = ""

        # Initialize from existing log
        self._initialize()

    @property
    def path(self) -> Path:
        """Path to audit log file."""
        return self._path

    @property
    def sequence(self) -> int:
        """Current sequence number."""
        return self._sequence

    def _initialize(self) -> None:
        """Initialize state from existing log file."""
        if not self._path.exists():
            # Create parent directory
            self._path.parent.mkdir(parents=True, exist_ok=True)
            return

        try:
            # Read last entry to get sequence and hash
            # Optimized: read last N bytes instead of byte-by-byte search (O(1) vs O(n))
            CHUNK_SIZE = 8192  # Typical max JSON entry size

            with open(self._path, "rb") as f:
                f.seek(0, 2)  # End of file
                file_size = f.tell()

                if file_size == 0:
                    return

                # Read last chunk
                read_size = min(CHUNK_SIZE, file_size)
                f.seek(file_size - read_size)
                chunk = f.read(read_size)

                # Find last complete line (after last newline in chunk)
                last_newline = chunk.rfind(b"\n", 0, len(chunk) - 1)

                if last_newline >= 0:
                    last_line = chunk[last_newline + 1:].decode("utf-8").strip()
                else:
                    # No newline found - entire chunk is one line
                    last_line = chunk.decode("utf-8").strip()

            if last_line:
                entry = AuditEntry.from_dict(json.loads(last_line))
                self._sequence = entry.sequence
                self._last_hash = entry.entry_hash
                logger.info(f"Initialized audit log at sequence {self._sequence}")

        except Exception as e:
            logger.error(f"Error initializing audit log: {e}")
            # Start fresh but don't delete existing data
            # This may cause sequence gaps but preserves data

    def log(
        self,
        action: AuditAction,
        session_id: str,
        data: dict[str, Any] | None = None,
        user_id: str | None = None,
        validate_chain: bool = True,
    ) -> AuditEntry:
        """
        Write an audit log entry.

        Thread-safe. Entries are appended atomically.
        Optionally validates the hash chain before writing to detect tampering.

        Args:
            action: Audit action type
            session_id: Session identifier
            data: Action-specific data
            user_id: User who initiated action (if known)
            validate_chain: If True, verify hash chain before writing (default True)

        Returns:
            The created audit entry

        Raises:
            ValueError: If hash chain validation fails (possible tampering)
        """
        with self._lock:
            # Validate hash chain before writing (detect tampering)
            if validate_chain and self._sequence > 0:
                actual_last_hash = self._get_actual_last_hash()
                if actual_last_hash is not None and actual_last_hash != self._last_hash:
                    raise ValueError(
                        f"Audit log hash chain validation failed! "
                        f"Expected: {self._last_hash[:16]}..., "
                        f"Found: {actual_last_hash[:16]}... "
                        f"Log may have been tampered with."
                    )

            self._sequence += 1

            entry = AuditEntry(
                sequence=self._sequence,
                timestamp=datetime.now(timezone.utc),
                action=action,
                session_id=session_id,
                user_id=user_id,
                data=data or {},
                previous_hash=self._last_hash,
            )

            # Compute entry hash
            entry.entry_hash = entry.compute_hash()

            # Write to file
            self._write_entry(entry)

            # Update state
            self._last_hash = entry.entry_hash

            logger.debug(f"Audit: {action.value} (seq={entry.sequence})")

            return entry

    def _get_actual_last_hash(self) -> str | None:
        """
        Read the actual last hash from the log file.

        Optimized to read last N bytes and find newline, avoiding O(n) byte-by-byte seek.

        Returns:
            Hash of the last entry, or None if file is empty/doesn't exist
        """
        if not self._path.exists():
            return None

        try:
            with open(self._path, "rb") as f:
                # Seek to end
                f.seek(0, 2)
                file_size = f.tell()

                if file_size == 0:
                    return None

                # Read last chunk (4KB should contain last JSON line)
                # Audit log entries are typically < 1KB each
                chunk_size = min(4096, file_size)
                f.seek(file_size - chunk_size)
                chunk = f.read(chunk_size)

                # Find last complete line (between last two newlines)
                lines = chunk.rsplit(b"\n", 2)

                # Get the last non-empty line
                if len(lines) >= 2 and lines[-2]:
                    last_line = lines[-2].decode("utf-8").strip()
                elif len(lines) >= 1 and lines[-1]:
                    last_line = lines[-1].decode("utf-8").strip()
                else:
                    return None

            if last_line:
                data = json.loads(last_line)
                return data.get("hash", "")

            return None

        except Exception as e:
            logger.error(f"Error reading last hash from audit log: {e}")
            return None

    def _write_entry(self, entry: AuditEntry) -> None:
        """Write entry to log file."""
        line = json.dumps(entry.to_dict(), separators=(",", ":")) + "\n"

        # Append atomically
        with open(self._path, "a") as f:
            f.write(line)
            f.flush()
            os.fsync(f.fileno())  # Ensure durability

    def verify_integrity(self) -> tuple[bool, int, str]:
        """
        Verify audit log integrity.

        Returns:
            Tuple of (valid, last_valid_sequence, error_message)
        """
        if not self._path.exists():
            return True, 0, ""

        last_hash = ""
        last_seq = 0

        try:
            with open(self._path, "r") as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        data = json.loads(line)
                        entry = AuditEntry.from_dict(data)
                    except Exception as e:
                        return False, last_seq, f"Line {line_num}: Invalid JSON - {e}"

                    # Verify sequence
                    if entry.sequence != last_seq + 1:
                        return (
                            False,
                            last_seq,
                            f"Line {line_num}: Sequence gap (expected {last_seq + 1}, got {entry.sequence})",
                        )

                    # Verify previous hash
                    if entry.previous_hash != last_hash:
                        return (
                            False,
                            last_seq,
                            f"Line {line_num}: Hash chain broken",
                        )

                    # Verify entry hash (supports both SHA256 and legacy CRC32)
                    if not entry.verify_hash():
                        return (
                            False,
                            last_seq,
                            f"Line {line_num}: Entry hash mismatch (tampered?)",
                        )

                    last_hash = entry.entry_hash
                    last_seq = entry.sequence

            return True, last_seq, ""

        except Exception as e:
            return False, last_seq, f"Error reading log: {e}"

    def read_entries(
        self,
        start_seq: int = 1,
        end_seq: int | None = None,
        action_filter: list[AuditAction] | None = None,
    ) -> list[AuditEntry]:
        """
        Read audit log entries.

        Args:
            start_seq: Starting sequence number
            end_seq: Ending sequence number (inclusive)
            action_filter: Filter by action types

        Returns:
            List of audit entries
        """
        if not self._path.exists():
            return []

        entries = []
        action_values = {a.value for a in action_filter} if action_filter else None

        with open(self._path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                try:
                    data = json.loads(line)
                    seq = data.get("seq", 0)

                    if seq < start_seq:
                        continue
                    if end_seq is not None and seq > end_seq:
                        break

                    if action_values and data.get("action") not in action_values:
                        continue

                    entries.append(AuditEntry.from_dict(data))

                except Exception:
                    continue  # Skip malformed entries

        return entries

    def get_order_history(self, order_id: str) -> list[AuditEntry]:
        """Get all audit entries for a specific order."""
        if not self._path.exists():
            return []

        entries = []
        order_actions = {
            AuditAction.ORDER_SUBMIT.value,
            AuditAction.ORDER_CANCEL.value,
            AuditAction.ORDER_MODIFY.value,
            AuditAction.ORDER_FILL.value,
            AuditAction.ORDER_REJECT.value,
        }

        with open(self._path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                try:
                    data = json.loads(line)
                    if data.get("action") not in order_actions:
                        continue

                    entry_data = data.get("data", {})
                    if entry_data.get("order_id") == order_id:
                        entries.append(AuditEntry.from_dict(data))

                except Exception:
                    continue

        return entries

    def archive_old_entries(
        self,
        archive_path: Path | None = None,
        days_threshold: int = ARCHIVE_AFTER_DAYS,
    ) -> tuple[int, Path | None]:
        """
        Archive entries older than threshold to compressed file.

        Entries are compressed with gzip and stored in archive directory.
        Original entries are NOT deleted from main log (append-only requirement).
        Archives are for efficient storage and faster queries.

        Args:
            archive_path: Directory for archives (default: ~/.quantlab/logs/archive)
            days_threshold: Archive entries older than this many days

        Returns:
            Tuple of (entries_archived, archive_file_path)
        """
        archive_dir = archive_path or DEFAULT_ARCHIVE_PATH
        archive_dir.mkdir(parents=True, exist_ok=True)

        if not self._path.exists():
            return 0, None

        threshold = datetime.now() - timedelta(days=days_threshold)
        entries_to_archive = []

        with open(self._path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                try:
                    data = json.loads(line)
                    ts = datetime.fromisoformat(data.get("ts", "").replace("Z", "+00:00"))
                    if ts < threshold:
                        entries_to_archive.append(line)
                except Exception:
                    continue

        if not entries_to_archive:
            return 0, None

        # Create archive filename with date range
        archive_file = archive_dir / f"audit_{threshold.strftime('%Y%m%d')}.log.gz"

        # Append to existing archive or create new
        mode = "ab" if archive_file.exists() else "wb"
        with gzip.open(archive_file, mode) as f:
            for line in entries_to_archive:
                f.write((line + "\n").encode("utf-8"))

        logger.info(f"Archived {len(entries_to_archive)} entries to {archive_file}")
        return len(entries_to_archive), archive_file

    def enforce_retention(
        self,
        archive_path: Path | None = None,
        retention_days: int = RETENTION_DAYS,
    ) -> tuple[int, list[Path]]:
        """
        Enforce retention policy by removing archives older than retention period.

        Per Technical Spec §13.3: 7-year retention requirement.
        Only archives can be deleted; main log is append-only.

        Args:
            archive_path: Directory for archives
            retention_days: Retention period in days (default: 7 years)

        Returns:
            Tuple of (files_deleted, deleted_file_paths)
        """
        archive_dir = archive_path or DEFAULT_ARCHIVE_PATH

        if not archive_dir.exists():
            return 0, []

        cutoff = datetime.now() - timedelta(days=retention_days)
        deleted_files: list[Path] = []

        for archive_file in archive_dir.glob("audit_*.log.gz"):
            try:
                # Extract date from filename (audit_YYYYMMDD.log.gz)
                date_str = archive_file.stem.replace("audit_", "").replace(".log", "")
                file_date = datetime.strptime(date_str, "%Y%m%d")

                if file_date < cutoff:
                    archive_file.unlink()
                    deleted_files.append(archive_file)
                    logger.info(f"Deleted archive beyond retention: {archive_file}")

            except (ValueError, OSError) as e:
                logger.warning(f"Could not process archive {archive_file}: {e}")

        return len(deleted_files), deleted_files

    def get_retention_status(
        self,
        archive_path: Path | None = None,
    ) -> dict[str, Any]:
        """
        Get current retention status.

        Returns:
            Dictionary with retention information
        """
        archive_dir = archive_path or DEFAULT_ARCHIVE_PATH

        main_size = self._path.stat().st_size if self._path.exists() else 0
        archive_size = 0
        archive_count = 0
        oldest_entry: datetime | None = None
        newest_entry: datetime | None = None

        if archive_dir.exists():
            for f in archive_dir.glob("audit_*.log.gz"):
                archive_size += f.stat().st_size
                archive_count += 1

        # Get date range from main log
        if self._path.exists():
            with open(self._path, "r") as f:
                first_line = f.readline().strip()
                if first_line:
                    try:
                        data = json.loads(first_line)
                        oldest_entry = datetime.fromisoformat(data.get("ts", "").replace("Z", "+00:00"))
                    except Exception:
                        pass

                # Seek to last line (read all lines and get last one)
                f.seek(0)
                lines = f.readlines()
                last_line = lines[-1].strip() if lines else ""
                if last_line:
                    try:
                        data = json.loads(last_line)
                        newest_entry = datetime.fromisoformat(data.get("ts", "").replace("Z", "+00:00"))
                    except Exception:
                        pass

        return {
            "main_log_size_bytes": main_size,
            "archive_size_bytes": archive_size,
            "archive_count": archive_count,
            "total_entries": self._sequence,
            "oldest_entry": oldest_entry.isoformat() if oldest_entry else None,
            "newest_entry": newest_entry.isoformat() if newest_entry else None,
            "retention_years": RETENTION_YEARS,
            "retention_days": RETENTION_DAYS,
        }


# Convenience functions for common audit actions


def audit_order_submit(
    audit_log: AuditLog,
    session_id: str,
    order_id: str,
    symbol: str,
    side: str,
    quantity: str,
    order_type: str,
    price: str | None = None,
    **kwargs: Any,
) -> AuditEntry:
    """Log order submission."""
    return audit_log.log(
        AuditAction.ORDER_SUBMIT,
        session_id,
        {
            "order_id": order_id,
            "symbol": symbol,
            "side": side,
            "quantity": quantity,
            "order_type": order_type,
            "price": price,
            **kwargs,
        },
    )


def audit_order_fill(
    audit_log: AuditLog,
    session_id: str,
    order_id: str,
    fill_quantity: str,
    fill_price: str,
    is_partial: bool = False,
    **kwargs: Any,
) -> AuditEntry:
    """Log order fill."""
    return audit_log.log(
        AuditAction.ORDER_FILL,
        session_id,
        {
            "order_id": order_id,
            "fill_quantity": fill_quantity,
            "fill_price": fill_price,
            "is_partial": is_partial,
            **kwargs,
        },
    )


def audit_session_start(
    audit_log: AuditLog,
    session_id: str,
    strategy_path: str,
    broker: str,
    symbols: list[str],
    user_id: str | None = None,
) -> AuditEntry:
    """Log session start."""
    return audit_log.log(
        AuditAction.SESSION_START,
        session_id,
        {
            "strategy_path": strategy_path,
            "broker": broker,
            "symbols": symbols,
        },
        user_id=user_id,
    )


def audit_risk_override(
    audit_log: AuditLog,
    session_id: str,
    override_type: str,
    reason: str,
    user_id: str,
    **kwargs: Any,
) -> AuditEntry:
    """Log risk override (requires user_id)."""
    return audit_log.log(
        AuditAction.MANUAL_OVERRIDE,
        session_id,
        {
            "override_type": override_type,
            "reason": reason,
            **kwargs,
        },
        user_id=user_id,
    )


def audit_order_modify(
    audit_log: AuditLog,
    session_id: str,
    order_id: str,
    modifications: dict[str, Any],
    user_id: str | None = None,
) -> AuditEntry:
    """Log order modification."""
    return audit_log.log(
        AuditAction.ORDER_MODIFY,
        session_id,
        {
            "order_id": order_id,
            "modifications": modifications,
        },
        user_id=user_id,
    )


def audit_order_cancel(
    audit_log: AuditLog,
    session_id: str,
    order_id: str,
    reason: str = "",
    user_id: str | None = None,
) -> AuditEntry:
    """Log order cancellation."""
    return audit_log.log(
        AuditAction.ORDER_CANCEL,
        session_id,
        {
            "order_id": order_id,
            "reason": reason,
        },
        user_id=user_id,
    )


def audit_position_open(
    audit_log: AuditLog,
    session_id: str,
    symbol: str,
    quantity: str,
    price: str,
    side: str,
) -> AuditEntry:
    """Log position open."""
    return audit_log.log(
        AuditAction.POSITION_OPEN,
        session_id,
        {
            "symbol": symbol,
            "quantity": quantity,
            "price": price,
            "side": side,
        },
    )


def audit_position_close(
    audit_log: AuditLog,
    session_id: str,
    symbol: str,
    quantity: str,
    exit_price: str,
    realized_pnl: str,
) -> AuditEntry:
    """Log position close."""
    return audit_log.log(
        AuditAction.POSITION_CLOSE,
        session_id,
        {
            "symbol": symbol,
            "quantity": quantity,
            "exit_price": exit_price,
            "realized_pnl": realized_pnl,
        },
    )


def audit_position_adjust(
    audit_log: AuditLog,
    session_id: str,
    symbol: str,
    old_quantity: str,
    new_quantity: str,
    price: str,
    reason: str = "",
) -> AuditEntry:
    """Log position adjustment."""
    return audit_log.log(
        AuditAction.POSITION_ADJUST,
        session_id,
        {
            "symbol": symbol,
            "old_quantity": old_quantity,
            "new_quantity": new_quantity,
            "price": price,
            "reason": reason,
        },
    )
