"""
Tamper-Evident Audit Ledger.

Provides append-only, tamper-evident logging for live trading sessions.

Features:
- Hash chaining for integrity verification
- CRC32 per entry for corruption detection
- fsync on critical entries (orders, fills)
- 7-year retention support

Spec Reference: Technical Spec §12.1, §12.3
"""

import binascii
import hashlib
import json
import os
import struct
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from enum import Enum
from pathlib import Path
from typing import Any
from typing import BinaryIO
from typing import Iterator


class EntryType(Enum):
    """Ledger entry types."""

    SESSION_START = "session_start"
    SESSION_END = "session_end"
    BAR = "bar"
    SIGNAL = "signal"
    ORDER_SUBMIT = "order_submit"
    ORDER_CANCEL = "order_cancel"
    ORDER_FILL = "order_fill"
    ORDER_REJECT = "order_reject"
    POSITION_SNAPSHOT = "position_snapshot"
    ERROR = "error"
    CHECKPOINT = "checkpoint"


# Entry types that require fsync for durability
CRITICAL_ENTRY_TYPES = {
    EntryType.ORDER_SUBMIT,
    EntryType.ORDER_FILL,
    EntryType.ORDER_CANCEL,
    EntryType.ORDER_REJECT,
    EntryType.SESSION_START,
    EntryType.SESSION_END,
}


@dataclass
class LedgerEntry:
    """
    Single entry in the audit ledger.

    Each entry includes:
    - Timestamp in UTC
    - Entry type
    - Payload data
    - CRC32 checksum
    - Hash chain link (previous entry hash)
    """

    sequence: int
    timestamp: datetime
    entry_type: EntryType
    payload: dict[str, Any]
    crc32: int = 0
    prev_hash: str = ""
    entry_hash: str = ""

    def compute_crc32(self) -> int:
        """Compute CRC32 of entry data."""
        data = json.dumps(
            {
                "sequence": self.sequence,
                "timestamp": self.timestamp.isoformat(),
                "type": self.entry_type.value,
                "payload": self.payload,
            },
            sort_keys=True,
        ).encode("utf-8")
        self.crc32 = binascii.crc32(data) & 0xFFFFFFFF
        return self.crc32

    def compute_hash(self) -> str:
        """
        Compute hash for chain integrity.

        Hash includes: sequence, timestamp, type, payload, crc32, prev_hash
        """
        data = json.dumps(
            {
                "sequence": self.sequence,
                "timestamp": self.timestamp.isoformat(),
                "type": self.entry_type.value,
                "payload": self.payload,
                "crc32": self.crc32,
                "prev_hash": self.prev_hash,
            },
            sort_keys=True,
        ).encode("utf-8")
        self.entry_hash = hashlib.sha256(data).hexdigest()
        return self.entry_hash

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "sequence": self.sequence,
            "timestamp": self.timestamp.isoformat() + "Z",
            "type": self.entry_type.value,
            "payload": self.payload,
            "crc32": self.crc32,
            "prev_hash": self.prev_hash,
            "entry_hash": self.entry_hash,
        }

    def to_json(self) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict())

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "LedgerEntry":
        """Create entry from dictionary."""
        timestamp = data["timestamp"]
        if isinstance(timestamp, str):
            timestamp = datetime.fromisoformat(timestamp.rstrip("Z")).replace(
                tzinfo=timezone.utc
            )

        return cls(
            sequence=data["sequence"],
            timestamp=timestamp,
            entry_type=EntryType(data["type"]),
            payload=data["payload"],
            crc32=data.get("crc32", 0),
            prev_hash=data.get("prev_hash", ""),
            entry_hash=data.get("entry_hash", ""),
        )

    @classmethod
    def from_json(cls, json_str: str) -> "LedgerEntry":
        """Create entry from JSON string."""
        return cls.from_dict(json.loads(json_str))

    def verify_crc32(self) -> bool:
        """Verify CRC32 matches."""
        original = self.crc32
        computed = self.compute_crc32()
        self.crc32 = original
        return original == computed

    def verify_hash(self) -> bool:
        """Verify hash matches."""
        original = self.entry_hash
        computed = self.compute_hash()
        self.entry_hash = original
        return original == computed


class AuditLedger:
    """
    Append-only tamper-evident audit ledger.

    Per §12.1, provides:
    - Write-ahead: Entry written BEFORE action
    - Sync: fsync after OrderEntry and FillEntry
    - Corruption detection: CRC32 per entry
    - Tamper evidence: Hash chaining
    """

    LEDGER_VERSION = 1
    HEADER_SIZE = 64

    def __init__(
        self,
        session_id: str,
        mode: str = "paper",
        ledger_dir: Path | None = None,
    ) -> None:
        """
        Initialize audit ledger.

        Args:
            session_id: Unique session identifier
            mode: Trading mode ('paper' or 'live')
            ledger_dir: Directory for ledger files
        """
        self.session_id = session_id
        self.mode = mode
        self.ledger_dir = ledger_dir or Path.home() / ".quantlab" / "audit"
        self.ledger_dir.mkdir(parents=True, exist_ok=True)

        self._ledger_path = self.ledger_dir / f"ledger_{session_id}.jsonl"
        self._file: BinaryIO | None = None
        self._sequence = 0
        self._last_hash = ""
        self._entry_count = 0
        self._closed = False

    def open(self) -> None:
        """Open ledger for writing."""
        if self._file is not None:
            return

        # Open in append binary mode for durability
        self._file = open(self._ledger_path, "ab", buffering=0)

        # If file exists, read last entry to get sequence and hash
        if self._ledger_path.stat().st_size > 0:
            self._recover_state()

    def _recover_state(self) -> None:
        """Recover sequence and hash from existing ledger."""
        with open(self._ledger_path, "rb") as f:
            last_line = None
            for line in f:
                if line.strip():
                    last_line = line

            if last_line:
                entry = LedgerEntry.from_json(last_line.decode("utf-8"))
                self._sequence = entry.sequence
                self._last_hash = entry.entry_hash
                self._entry_count = entry.sequence + 1

    def close(self) -> None:
        """Close ledger."""
        if self._file is not None:
            self._file.close()
            self._file = None
        self._closed = True

    def append(
        self,
        entry_type: EntryType,
        payload: dict[str, Any],
        force_sync: bool = False,
    ) -> LedgerEntry:
        """
        Append entry to ledger.

        Write-ahead: Entry is written BEFORE returning.
        Critical entries (orders, fills) trigger fsync.

        Args:
            entry_type: Type of entry
            payload: Entry data
            force_sync: Force fsync even for non-critical entries

        Returns:
            Created LedgerEntry
        """
        if self._file is None:
            self.open()

        # Create entry
        entry = LedgerEntry(
            sequence=self._sequence,
            timestamp=datetime.now(timezone.utc),
            entry_type=entry_type,
            payload=payload,
            prev_hash=self._last_hash,
        )

        # Compute integrity values
        entry.compute_crc32()
        entry.compute_hash()

        # Write entry
        line = entry.to_json() + "\n"
        self._file.write(line.encode("utf-8"))

        # Sync critical entries
        if entry_type in CRITICAL_ENTRY_TYPES or force_sync:
            self._file.flush()
            os.fsync(self._file.fileno())

        # Update state
        self._sequence += 1
        self._last_hash = entry.entry_hash
        self._entry_count += 1

        return entry

    def read_all(self) -> list[LedgerEntry]:
        """Read all entries from ledger."""
        entries = []
        with open(self._ledger_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    entries.append(LedgerEntry.from_json(line))
        return entries

    def iter_entries(self) -> Iterator[LedgerEntry]:
        """Iterate over entries lazily."""
        with open(self._ledger_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    yield LedgerEntry.from_json(line)

    def verify_integrity(self) -> tuple[bool, list[str]]:
        """
        Verify ledger integrity.

        Checks:
        - CRC32 of each entry
        - Hash chain continuity

        Returns:
            Tuple of (is_valid, list of error messages)
        """
        errors: list[str] = []
        prev_hash = ""

        for entry in self.iter_entries():
            # Verify CRC32
            if not entry.verify_crc32():
                errors.append(
                    f"CRC32 mismatch at sequence {entry.sequence}: "
                    f"expected {entry.crc32}"
                )

            # Verify hash chain
            if entry.prev_hash != prev_hash:
                errors.append(
                    f"Hash chain broken at sequence {entry.sequence}: "
                    f"expected {prev_hash}, got {entry.prev_hash}"
                )

            # Verify entry hash
            if not entry.verify_hash():
                errors.append(
                    f"Entry hash mismatch at sequence {entry.sequence}"
                )

            prev_hash = entry.entry_hash

        return len(errors) == 0, errors

    def get_entry(self, sequence: int) -> LedgerEntry | None:
        """Get entry by sequence number."""
        for entry in self.iter_entries():
            if entry.sequence == sequence:
                return entry
        return None

    def get_entries_by_type(self, entry_type: EntryType) -> list[LedgerEntry]:
        """Get all entries of a specific type."""
        return [e for e in self.iter_entries() if e.entry_type == entry_type]

    def get_order_entries(self) -> list[LedgerEntry]:
        """Get all order-related entries."""
        order_types = {
            EntryType.ORDER_SUBMIT,
            EntryType.ORDER_CANCEL,
            EntryType.ORDER_FILL,
            EntryType.ORDER_REJECT,
        }
        return [e for e in self.iter_entries() if e.entry_type in order_types]

    @property
    def entry_count(self) -> int:
        """Number of entries in ledger."""
        return self._entry_count

    @property
    def path(self) -> Path:
        """Path to ledger file."""
        return self._ledger_path

    def __enter__(self) -> "AuditLedger":
        """Context manager entry."""
        self.open()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        """Context manager exit."""
        self.close()


# Convenience functions for creating entries


def log_session_start(
    ledger: AuditLedger,
    strategy_name: str,
    parameters: dict[str, Any],
    initial_capital: float,
) -> LedgerEntry:
    """Log session start."""
    return ledger.append(
        EntryType.SESSION_START,
        {
            "strategy_name": strategy_name,
            "parameters": parameters,
            "initial_capital": initial_capital,
            "mode": ledger.mode,
        },
    )


def log_session_end(
    ledger: AuditLedger,
    final_equity: float,
    reason: str,
) -> LedgerEntry:
    """Log session end."""
    return ledger.append(
        EntryType.SESSION_END,
        {
            "final_equity": final_equity,
            "reason": reason,
        },
    )


def log_order_submit(
    ledger: AuditLedger,
    order_id: str,
    symbol: str,
    side: str,
    quantity: float,
    order_type: str,
    limit_price: float | None = None,
    stop_price: float | None = None,
) -> LedgerEntry:
    """Log order submission."""
    return ledger.append(
        EntryType.ORDER_SUBMIT,
        {
            "order_id": order_id,
            "symbol": symbol,
            "side": side,
            "quantity": quantity,
            "order_type": order_type,
            "limit_price": limit_price,
            "stop_price": stop_price,
        },
    )


def log_order_fill(
    ledger: AuditLedger,
    order_id: str,
    fill_id: str,
    filled_qty: float,
    fill_price: float,
    commission: float,
) -> LedgerEntry:
    """Log order fill."""
    return ledger.append(
        EntryType.ORDER_FILL,
        {
            "order_id": order_id,
            "fill_id": fill_id,
            "filled_qty": filled_qty,
            "fill_price": fill_price,
            "commission": commission,
        },
    )


def log_order_cancel(
    ledger: AuditLedger,
    order_id: str,
    reason: str,
) -> LedgerEntry:
    """Log order cancellation."""
    return ledger.append(
        EntryType.ORDER_CANCEL,
        {
            "order_id": order_id,
            "reason": reason,
        },
    )


def log_order_reject(
    ledger: AuditLedger,
    order_id: str,
    reason: str,
    error_code: str | None = None,
) -> LedgerEntry:
    """Log order rejection."""
    return ledger.append(
        EntryType.ORDER_REJECT,
        {
            "order_id": order_id,
            "reason": reason,
            "error_code": error_code,
        },
    )


def log_position_snapshot(
    ledger: AuditLedger,
    positions: list[dict[str, Any]],
    equity: float,
) -> LedgerEntry:
    """Log position snapshot."""
    return ledger.append(
        EntryType.POSITION_SNAPSHOT,
        {
            "positions": positions,
            "equity": equity,
        },
    )


def log_error(
    ledger: AuditLedger,
    error_code: str,
    message: str,
    context: dict[str, Any] | None = None,
) -> LedgerEntry:
    """Log error."""
    return ledger.append(
        EntryType.ERROR,
        {
            "error_code": error_code,
            "message": message,
            "context": context or {},
        },
    )
