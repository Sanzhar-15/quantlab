"""
Session Ledger with Write-Ahead Logging.

Provides durable state persistence with CRC32 integrity verification.
Supports crash recovery and state reconstruction.

Spec Reference: Technical Spec §8.4 (Session Durability)
"""

import json
import logging
import os
import struct
import threading
import time
import zlib
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any
from typing import BinaryIO
from typing import Iterator


logger = logging.getLogger(__name__)


# Ledger file format constants
LEDGER_MAGIC = b"QLAB"  # Magic bytes for file identification
LEDGER_VERSION = 1
HEADER_SIZE = 16  # 4 magic + 4 version + 8 timestamp
ENTRY_HEADER_SIZE = 16  # 4 length + 4 crc32 + 8 sequence


class EntryType(Enum):
    """Types of ledger entries."""

    # Session lifecycle
    SESSION_START = "session_start"
    SESSION_STOP = "session_stop"
    SESSION_PAUSE = "session_pause"
    SESSION_RESUME = "session_resume"

    # Order events
    ORDER_SUBMITTED = "order_submitted"
    ORDER_FILLED = "order_filled"
    ORDER_PARTIAL_FILL = "order_partial_fill"
    ORDER_CANCELLED = "order_cancelled"
    ORDER_REJECTED = "order_rejected"

    # Position events
    POSITION_OPENED = "position_opened"
    POSITION_CLOSED = "position_closed"
    POSITION_UPDATED = "position_updated"

    # Risk events
    CIRCUIT_BREAKER_TRIPPED = "circuit_breaker_tripped"
    CIRCUIT_BREAKER_RESET = "circuit_breaker_reset"
    EXPOSURE_UPDATED = "exposure_updated"

    # State snapshots
    STATE_SNAPSHOT = "state_snapshot"
    CHECKPOINT = "checkpoint"

    # Custom
    CUSTOM = "custom"


@dataclass
class LedgerEntry:
    """A single entry in the session ledger."""

    sequence: int
    timestamp: float
    entry_type: EntryType
    data: dict[str, Any]
    crc32: int = 0

    def to_bytes(self) -> bytes:
        """Serialize entry to bytes."""
        payload = json.dumps({
            "seq": self.sequence,
            "ts": self.timestamp,
            "type": self.entry_type.value,
            "data": self.data,
        }).encode("utf-8")

        # Calculate CRC32 of payload
        crc = zlib.crc32(payload) & 0xFFFFFFFF

        # Entry format: [4 length][4 crc32][8 sequence][payload]
        header = struct.pack(">IIQ", len(payload), crc, self.sequence)

        return header + payload

    @classmethod
    def from_bytes(cls, data: bytes) -> "LedgerEntry":
        """Deserialize entry from bytes."""
        if len(data) < ENTRY_HEADER_SIZE:
            raise ValueError("Entry too short")

        length, crc, sequence = struct.unpack(">IIQ", data[:ENTRY_HEADER_SIZE])
        payload = data[ENTRY_HEADER_SIZE:ENTRY_HEADER_SIZE + length]

        if len(payload) != length:
            raise ValueError(f"Payload length mismatch: expected {length}, got {len(payload)}")

        # Verify CRC32
        calculated_crc = zlib.crc32(payload) & 0xFFFFFFFF
        if calculated_crc != crc:
            raise ValueError(f"CRC32 mismatch: expected {crc}, got {calculated_crc}")

        # Parse JSON payload
        obj = json.loads(payload.decode("utf-8"))

        return cls(
            sequence=obj["seq"],
            timestamp=obj["ts"],
            entry_type=EntryType(obj["type"]),
            data=obj["data"],
            crc32=crc,
        )

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "sequence": self.sequence,
            "timestamp": self.timestamp,
            "entry_type": self.entry_type.value,
            "data": self.data,
            "crc32": hex(self.crc32),
        }


@dataclass
class LedgerStats:
    """Statistics about the ledger."""

    total_entries: int
    first_sequence: int
    last_sequence: int
    first_timestamp: float
    last_timestamp: float
    file_size_bytes: int
    entries_by_type: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "total_entries": self.total_entries,
            "first_sequence": self.first_sequence,
            "last_sequence": self.last_sequence,
            "first_timestamp": datetime.fromtimestamp(self.first_timestamp).isoformat() if self.first_timestamp else None,
            "last_timestamp": datetime.fromtimestamp(self.last_timestamp).isoformat() if self.last_timestamp else None,
            "file_size_bytes": self.file_size_bytes,
            "entries_by_type": self.entries_by_type,
        }


class SessionLedger:
    """
    Write-ahead log for trading session state.

    Provides:
    - Durable persistence of all session events
    - CRC32 integrity verification
    - Crash recovery and state reconstruction
    - Efficient append-only writes

    File Format:
    - Header: [4 magic][4 version][8 created_timestamp]
    - Entries: [4 length][4 crc32][8 sequence][json_payload]
    """

    def __init__(
        self,
        session_id: str,
        ledger_dir: Path | str | None = None,
        sync_mode: str = "fsync",  # "none", "write", "fsync"
        max_entries_memory: int = 1000,
    ) -> None:
        """
        Initialize session ledger.

        Args:
            session_id: Unique session identifier
            ledger_dir: Directory for ledger files (default: ~/.quantlab/ledgers)
            sync_mode: Durability mode ("none", "write", "fsync")
            max_entries_memory: Maximum entries to keep in memory
        """
        self._session_id = session_id
        self._ledger_dir = Path(ledger_dir) if ledger_dir else Path.home() / ".quantlab" / "ledgers"
        self._sync_mode = sync_mode
        self._max_entries_memory = max_entries_memory

        self._lock = threading.Lock()
        self._sequence = 0
        self._entries: list[LedgerEntry] = []
        self._file: BinaryIO | None = None
        self._file_path: Path | None = None

        # Track state
        self._is_open = False
        self._created_at: float = 0
        self._last_write_at: float = 0

    @property
    def session_id(self) -> str:
        """Session ID."""
        return self._session_id

    @property
    def sequence(self) -> int:
        """Current sequence number."""
        return self._sequence

    @property
    def is_open(self) -> bool:
        """Whether ledger is open for writing."""
        return self._is_open

    def open(self, resume: bool = False) -> None:
        """
        Open the ledger for writing.

        Args:
            resume: If True, resume from existing ledger
        """
        if self._is_open:
            return

        # Ensure directory exists
        self._ledger_dir.mkdir(parents=True, exist_ok=True)
        self._file_path = self._ledger_dir / f"{self._session_id}.wal"

        if resume and self._file_path.exists():
            # Resume from existing ledger
            self._resume_ledger()
        else:
            # Create new ledger
            self._create_ledger()

        self._is_open = True
        logger.info(f"Ledger opened: {self._file_path} (sequence={self._sequence})")

    def _create_ledger(self) -> None:
        """Create a new ledger file."""
        self._created_at = time.time()
        self._sequence = 0
        self._entries.clear()

        # Remove existing file if present
        if self._file_path and self._file_path.exists():
            self._file_path.unlink()

        # Open for writing
        self._file = open(self._file_path, "wb")

        # Write header
        header = struct.pack(
            ">4sIQ",
            LEDGER_MAGIC,
            LEDGER_VERSION,
            int(self._created_at * 1000),  # Milliseconds
        )
        self._file.write(header)
        self._sync()

    def _resume_ledger(self) -> None:
        """Resume from an existing ledger file."""
        # Read and verify existing entries
        entries = list(self._read_entries(self._file_path))

        if entries:
            self._sequence = entries[-1].sequence
            # Keep recent entries in memory
            self._entries = entries[-self._max_entries_memory:]
            self._created_at = entries[0].timestamp
        else:
            self._sequence = 0
            self._entries.clear()
            self._created_at = time.time()

        # Open for append
        self._file = open(self._file_path, "ab")
        logger.info(f"Resumed ledger with {len(entries)} entries")

    def close(self) -> None:
        """Close the ledger."""
        if not self._is_open:
            return

        with self._lock:
            if self._file:
                self._sync()
                self._file.close()
                self._file = None

            self._is_open = False
            logger.info(f"Ledger closed: {self._file_path}")

    def append(
        self,
        entry_type: EntryType,
        data: dict[str, Any],
    ) -> LedgerEntry:
        """
        Append an entry to the ledger.

        Thread-safe: uses lock to protect sequence and file writes.

        Args:
            entry_type: Type of entry
            data: Entry data

        Returns:
            The created LedgerEntry
        """
        if not self._is_open:
            raise RuntimeError("Ledger is not open")

        with self._lock:
            self._sequence += 1

            entry = LedgerEntry(
                sequence=self._sequence,
                timestamp=time.time(),
                entry_type=entry_type,
                data=data,
            )

            # Serialize and write
            entry_bytes = entry.to_bytes()

            if self._file:
                self._file.write(entry_bytes)
                self._sync()
                self._last_write_at = entry.timestamp

            # Update CRC32 for the entry object
            entry.crc32 = zlib.crc32(
                json.dumps({
                    "seq": entry.sequence,
                    "ts": entry.timestamp,
                    "type": entry.entry_type.value,
                    "data": entry.data,
                }).encode("utf-8")
            ) & 0xFFFFFFFF

            # Keep in memory (with limit)
            self._entries.append(entry)
            if len(self._entries) > self._max_entries_memory:
                self._entries = self._entries[-self._max_entries_memory:]

            return entry

    def _sync(self) -> None:
        """Sync file to disk based on sync mode."""
        if self._file is None:
            return

        if self._sync_mode == "write":
            self._file.flush()
        elif self._sync_mode == "fsync":
            self._file.flush()
            os.fsync(self._file.fileno())

    def _read_entries(self, path: Path) -> Iterator[LedgerEntry]:
        """
        Read all entries from a ledger file.

        Yields:
            LedgerEntry for each valid entry
        """
        if not path.exists():
            return

        with open(path, "rb") as f:
            # Verify header
            header = f.read(HEADER_SIZE)
            if len(header) < HEADER_SIZE:
                logger.warning(f"Ledger header too short: {path}")
                return

            magic, version, created_ms = struct.unpack(">4sIQ", header)

            if magic != LEDGER_MAGIC:
                logger.warning(f"Invalid ledger magic: {magic}")
                return

            if version != LEDGER_VERSION:
                logger.warning(f"Unsupported ledger version: {version}")
                return

            # Read entries
            while True:
                # Read entry header
                entry_header = f.read(ENTRY_HEADER_SIZE)
                if len(entry_header) < ENTRY_HEADER_SIZE:
                    break

                length, crc, sequence = struct.unpack(">IIQ", entry_header)

                # Read payload
                payload = f.read(length)
                if len(payload) < length:
                    logger.warning(f"Truncated entry at sequence {sequence}")
                    break

                # Verify CRC32
                calculated_crc = zlib.crc32(payload) & 0xFFFFFFFF
                if calculated_crc != crc:
                    logger.warning(
                        f"CRC32 mismatch at sequence {sequence}: "
                        f"expected {crc}, got {calculated_crc}"
                    )
                    continue  # Skip corrupted entry

                try:
                    obj = json.loads(payload.decode("utf-8"))
                    yield LedgerEntry(
                        sequence=obj["seq"],
                        timestamp=obj["ts"],
                        entry_type=EntryType(obj["type"]),
                        data=obj["data"],
                        crc32=crc,
                    )
                except (json.JSONDecodeError, KeyError, ValueError) as e:
                    logger.warning(f"Invalid entry at sequence {sequence}: {e}")

    def get_entries(
        self,
        entry_type: EntryType | None = None,
        since_sequence: int | None = None,
        limit: int | None = None,
    ) -> list[LedgerEntry]:
        """
        Get entries from memory.

        Args:
            entry_type: Filter by type
            since_sequence: Get entries after this sequence
            limit: Maximum entries to return

        Returns:
            List of matching entries
        """
        with self._lock:
            entries = self._entries.copy()

        if entry_type is not None:
            entries = [e for e in entries if e.entry_type == entry_type]

        if since_sequence is not None:
            entries = [e for e in entries if e.sequence > since_sequence]

        if limit is not None:
            entries = entries[-limit:]

        return entries

    def read_all_entries(self) -> list[LedgerEntry]:
        """
        Read all entries from the ledger file.

        Returns:
            List of all entries
        """
        if self._file_path is None or not self._file_path.exists():
            return []

        return list(self._read_entries(self._file_path))

    def verify_integrity(self) -> tuple[bool, list[str]]:
        """
        Verify the integrity of the ledger file.

        Returns:
            Tuple of (is_valid, list of error messages)
        """
        if self._file_path is None or not self._file_path.exists():
            return False, ["Ledger file does not exist"]

        errors: list[str] = []
        expected_sequence = 0

        for entry in self._read_entries(self._file_path):
            expected_sequence += 1
            if entry.sequence != expected_sequence:
                errors.append(
                    f"Sequence gap: expected {expected_sequence}, got {entry.sequence}"
                )
                expected_sequence = entry.sequence

        if errors:
            return False, errors

        return True, []

    def get_stats(self) -> LedgerStats:
        """Get ledger statistics."""
        entries = self.read_all_entries()

        if not entries:
            return LedgerStats(
                total_entries=0,
                first_sequence=0,
                last_sequence=0,
                first_timestamp=0,
                last_timestamp=0,
                file_size_bytes=0,
            )

        by_type: dict[str, int] = {}
        for entry in entries:
            type_key = entry.entry_type.value
            by_type[type_key] = by_type.get(type_key, 0) + 1

        file_size = self._file_path.stat().st_size if self._file_path and self._file_path.exists() else 0

        return LedgerStats(
            total_entries=len(entries),
            first_sequence=entries[0].sequence,
            last_sequence=entries[-1].sequence,
            first_timestamp=entries[0].timestamp,
            last_timestamp=entries[-1].timestamp,
            file_size_bytes=file_size,
            entries_by_type=by_type,
        )

    def checkpoint(self, state: dict[str, Any]) -> LedgerEntry:
        """
        Write a checkpoint with full state snapshot.

        Checkpoints allow faster recovery by providing a full state
        that can be used as a starting point.

        Args:
            state: Full state snapshot

        Returns:
            The checkpoint entry
        """
        return self.append(EntryType.CHECKPOINT, {
            "checkpoint_time": datetime.now().isoformat(),
            "state": state,
        })

    def compact(self, keep_entries: int = 1000) -> int:
        """
        Compact the ledger by removing old entries.

        Creates a new ledger file with only recent entries
        and the last checkpoint.

        Args:
            keep_entries: Number of recent entries to keep

        Returns:
            Number of entries removed
        """
        if self._file_path is None:
            return 0

        all_entries = self.read_all_entries()

        if len(all_entries) <= keep_entries:
            return 0

        # Find last checkpoint
        last_checkpoint: LedgerEntry | None = None
        for entry in reversed(all_entries):
            if entry.entry_type == EntryType.CHECKPOINT:
                last_checkpoint = entry
                break

        # Entries to keep: last checkpoint + recent entries
        keep: list[LedgerEntry] = []
        if last_checkpoint:
            keep.append(last_checkpoint)

        recent = all_entries[-keep_entries:]
        for entry in recent:
            if entry not in keep:
                keep.append(entry)

        removed_count = len(all_entries) - len(keep)

        # Close current file
        was_open = self._is_open
        self.close()

        # Rename old file
        backup_path = self._file_path.with_suffix(".wal.bak")
        self._file_path.rename(backup_path)

        # Write compacted file
        self._create_ledger()
        self._is_open = True

        for entry in sorted(keep, key=lambda e: e.sequence):
            self.append(entry.entry_type, entry.data)

        # Remove backup
        backup_path.unlink()

        if not was_open:
            self.close()

        logger.info(f"Ledger compacted: removed {removed_count} entries")
        return removed_count

    # Convenience methods for common entry types

    def log_order_submitted(self, order_data: dict[str, Any]) -> LedgerEntry:
        """Log an order submission."""
        return self.append(EntryType.ORDER_SUBMITTED, order_data)

    def log_order_filled(self, fill_data: dict[str, Any]) -> LedgerEntry:
        """Log an order fill."""
        return self.append(EntryType.ORDER_FILLED, fill_data)

    def log_order_cancelled(self, cancel_data: dict[str, Any]) -> LedgerEntry:
        """Log an order cancellation."""
        return self.append(EntryType.ORDER_CANCELLED, cancel_data)

    def log_position_opened(self, position_data: dict[str, Any]) -> LedgerEntry:
        """Log a position being opened."""
        return self.append(EntryType.POSITION_OPENED, position_data)

    def log_position_closed(self, close_data: dict[str, Any]) -> LedgerEntry:
        """Log a position being closed."""
        return self.append(EntryType.POSITION_CLOSED, close_data)

    def log_circuit_breaker_tripped(self, reason: str, metadata: dict[str, Any]) -> LedgerEntry:
        """Log circuit breaker being tripped."""
        return self.append(EntryType.CIRCUIT_BREAKER_TRIPPED, {
            "reason": reason,
            "metadata": metadata,
        })

    def log_circuit_breaker_reset(self, acknowledged_by: str | None = None) -> LedgerEntry:
        """Log circuit breaker being reset."""
        return self.append(EntryType.CIRCUIT_BREAKER_RESET, {
            "acknowledged_by": acknowledged_by,
        })

    def log_custom(self, event_name: str, data: dict[str, Any]) -> LedgerEntry:
        """Log a custom event."""
        return self.append(EntryType.CUSTOM, {
            "event": event_name,
            **data,
        })

    # =========================================================================
    # Export Methods (FIX-T006)
    # =========================================================================

    def to_json(
        self,
        output_path: Path | str | None = None,
        pretty: bool = True,
    ) -> str:
        """
        Export ledger entries to JSON format (FIX-T006).

        Args:
            output_path: Optional path to write JSON file
            pretty: Whether to format with indentation

        Returns:
            JSON string of all entries
        """
        entries = self.read_all_entries()
        data = {
            "session_id": self._session_id,
            "created_at": datetime.fromtimestamp(self._created_at).isoformat() if self._created_at else None,
            "total_entries": len(entries),
            "entries": [entry.to_dict() for entry in entries],
        }

        indent = 2 if pretty else None
        json_str = json.dumps(data, indent=indent, default=str)

        if output_path:
            Path(output_path).write_text(json_str, encoding="utf-8")
            logger.info(f"Exported ledger to JSON: {output_path}")

        return json_str

    def to_csv(
        self,
        output_path: Path | str | None = None,
        include_data: bool = False,
    ) -> str:
        """
        Export ledger entries to CSV format (FIX-T006).

        Args:
            output_path: Optional path to write CSV file
            include_data: Whether to include serialized data column

        Returns:
            CSV string of all entries
        """
        import csv
        import io

        entries = self.read_all_entries()

        output = io.StringIO()
        fieldnames = ["sequence", "timestamp", "entry_type", "crc32"]
        if include_data:
            fieldnames.append("data")

        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()

        for entry in entries:
            row = {
                "sequence": entry.sequence,
                "timestamp": datetime.fromtimestamp(entry.timestamp).isoformat(),
                "entry_type": entry.entry_type.value,
                "crc32": hex(entry.crc32),
            }
            if include_data:
                row["data"] = json.dumps(entry.data)
            writer.writerow(row)

        csv_str = output.getvalue()

        if output_path:
            Path(output_path).write_text(csv_str, encoding="utf-8")
            logger.info(f"Exported ledger to CSV: {output_path}")

        return csv_str

    def export(
        self,
        output_path: Path | str,
        format: str = "json",
    ) -> None:
        """
        Export ledger to file (FIX-T006).

        Args:
            output_path: Path to output file
            format: Export format ("json" or "csv")

        Raises:
            ValueError: If format not supported
        """
        if format.lower() == "json":
            self.to_json(output_path)
        elif format.lower() == "csv":
            self.to_csv(output_path, include_data=True)
        else:
            raise ValueError(f"Unsupported export format: {format}. Use 'json' or 'csv'.")

    def __enter__(self) -> "SessionLedger":
        """Context manager entry."""
        self.open()
        return self

    def __exit__(self, *args: Any) -> None:
        """Context manager exit."""
        self.close()


def recover_session_state(
    session_id: str,
    ledger_dir: Path | str | None = None,
) -> dict[str, Any]:
    """
    Recover session state from the ledger.

    Replays events from the most recent checkpoint to reconstruct state.

    Args:
        session_id: Session ID to recover
        ledger_dir: Directory containing ledger files

    Returns:
        Reconstructed session state
    """
    ledger_path = (Path(ledger_dir) if ledger_dir else Path.home() / ".quantlab" / "ledgers")
    ledger_file = ledger_path / f"{session_id}.wal"

    if not ledger_file.exists():
        return {"error": "Ledger file not found", "session_id": session_id}

    # Create temporary ledger to read entries
    ledger = SessionLedger(session_id, ledger_dir)
    entries = ledger.read_all_entries()

    if not entries:
        return {"error": "No entries in ledger", "session_id": session_id}

    # Find last checkpoint
    state: dict[str, Any] = {}
    start_idx = 0

    for i, entry in enumerate(reversed(entries)):
        if entry.entry_type == EntryType.CHECKPOINT:
            state = entry.data.get("state", {})
            start_idx = len(entries) - i
            break

    # Initialize state structure
    if "orders" not in state:
        state["orders"] = {}
    if "positions" not in state:
        state["positions"] = {}
    if "circuit_breaker" not in state:
        state["circuit_breaker"] = {"is_open": False}

    # Replay events from checkpoint
    for entry in entries[start_idx:]:
        _apply_entry_to_state(entry, state)

    state["recovered_at"] = datetime.now().isoformat()
    state["last_sequence"] = entries[-1].sequence if entries else 0
    state["entries_replayed"] = len(entries) - start_idx

    return state


def _apply_entry_to_state(entry: LedgerEntry, state: dict[str, Any]) -> None:
    """Apply a ledger entry to the session state."""
    data = entry.data

    if entry.entry_type == EntryType.ORDER_SUBMITTED:
        order_id = data.get("order_id")
        if order_id:
            state["orders"][order_id] = {
                "status": "submitted",
                **data,
            }

    elif entry.entry_type == EntryType.ORDER_FILLED:
        order_id = data.get("order_id")
        if order_id and order_id in state["orders"]:
            state["orders"][order_id]["status"] = "filled"
            state["orders"][order_id].update(data)

    elif entry.entry_type == EntryType.ORDER_CANCELLED:
        order_id = data.get("order_id")
        if order_id and order_id in state["orders"]:
            state["orders"][order_id]["status"] = "cancelled"

    elif entry.entry_type == EntryType.POSITION_OPENED:
        symbol = data.get("symbol")
        if symbol:
            state["positions"][symbol] = {
                "status": "open",
                **data,
            }

    elif entry.entry_type == EntryType.POSITION_CLOSED:
        symbol = data.get("symbol")
        if symbol and symbol in state["positions"]:
            state["positions"][symbol]["status"] = "closed"
            state["positions"][symbol].update(data)

    elif entry.entry_type == EntryType.CIRCUIT_BREAKER_TRIPPED:
        state["circuit_breaker"] = {
            "is_open": True,
            "reason": data.get("reason"),
            "tripped_at": entry.timestamp,
        }

    elif entry.entry_type == EntryType.CIRCUIT_BREAKER_RESET:
        state["circuit_breaker"] = {"is_open": False}
