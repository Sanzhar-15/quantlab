"""
Backtest Debug File Format and Reader.

Provides efficient storage and retrieval of backtest state for debugging,
replay, and time-travel analysis.

Uses memory-mapped file access for efficient random access to large files.

Spec Reference: Technical Spec §19 (Debugger)
"""

import json
import logging
import mmap
import os
import struct
import zlib
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from enum import Enum
from pathlib import Path
from typing import Any
from typing import BinaryIO
from typing import Iterator


logger = logging.getLogger(__name__)


# File format constants
DEBUG_MAGIC = b"QLDB"  # Quantlab Debug
DEBUG_VERSION = 1
HEADER_SIZE = 32  # 4 magic + 4 version + 8 created_ts + 8 entry_count + 8 index_offset
ENTRY_HEADER_SIZE = 20  # 4 type + 4 bar_index + 4 length + 4 crc32 + 4 flags


class DebugEntryType(Enum):
    """Types of debug entries."""

    # Bar events
    BAR_START = 1
    BAR_END = 2

    # Order events
    ORDER_SUBMITTED = 10
    ORDER_FILLED = 11
    ORDER_CANCELLED = 12
    ORDER_REJECTED = 13

    # Position events
    POSITION_OPENED = 20
    POSITION_UPDATED = 21
    POSITION_CLOSED = 22

    # State snapshots
    STATE_SNAPSHOT = 30
    EQUITY_SNAPSHOT = 31

    # Signal events
    SIGNAL_GENERATED = 40

    # Risk events
    RISK_CHECK = 50
    CIRCUIT_BREAKER = 51

    # Custom markers
    MARKER = 100
    ANNOTATION = 101


@dataclass
class DebugEntry:
    """A single debug entry."""

    entry_type: DebugEntryType
    bar_index: int
    timestamp: float
    data: dict[str, Any]
    flags: int = 0

    def to_bytes(self) -> bytes:
        """Serialize entry to bytes."""
        payload = json.dumps({
            "ts": self.timestamp,
            "data": self.data,
        }, default=_json_serializer).encode("utf-8")

        crc = zlib.crc32(payload) & 0xFFFFFFFF

        # Header: [4 type][4 bar_index][4 length][4 crc32][4 flags]
        header = struct.pack(
            ">IIIIH2x",  # 2x for padding to 20 bytes
            self.entry_type.value,
            self.bar_index,
            len(payload),
            crc,
            self.flags,
        )

        return header + payload

    @classmethod
    def from_bytes(cls, data: bytes) -> "DebugEntry":
        """Deserialize entry from bytes."""
        if len(data) < ENTRY_HEADER_SIZE:
            raise ValueError("Entry too short")

        entry_type, bar_index, length, crc, flags = struct.unpack(
            ">IIIIH2x", data[:ENTRY_HEADER_SIZE]
        )

        payload = data[ENTRY_HEADER_SIZE:ENTRY_HEADER_SIZE + length]

        if len(payload) != length:
            raise ValueError(f"Payload length mismatch: expected {length}, got {len(payload)}")

        # Verify CRC32
        calculated_crc = zlib.crc32(payload) & 0xFFFFFFFF
        if calculated_crc != crc:
            raise ValueError(f"CRC32 mismatch: expected {crc}, got {calculated_crc}")

        obj = json.loads(payload.decode("utf-8"))

        return cls(
            entry_type=DebugEntryType(entry_type),
            bar_index=bar_index,
            timestamp=obj["ts"],
            data=obj["data"],
            flags=flags,
        )

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "entryType": self.entry_type.name,
            "barIndex": self.bar_index,
            "timestamp": self.timestamp,
            "data": self.data,
            "flags": self.flags,
        }


@dataclass
class DebugIndex:
    """Index for fast bar-based lookups."""

    # Map bar_index -> file offset of first entry for that bar
    bar_offsets: dict[int, int] = field(default_factory=dict)

    # Map bar_index -> count of entries for that bar
    bar_entry_counts: dict[int, int] = field(default_factory=dict)

    # Entry type index for filtering
    type_offsets: dict[int, list[int]] = field(default_factory=dict)

    def to_bytes(self) -> bytes:
        """Serialize index to bytes."""
        data = {
            "bar_offsets": self.bar_offsets,
            "bar_entry_counts": self.bar_entry_counts,
            "type_offsets": {str(k): v for k, v in self.type_offsets.items()},
        }
        return json.dumps(data).encode("utf-8")

    @classmethod
    def from_bytes(cls, data: bytes) -> "DebugIndex":
        """Deserialize index from bytes."""
        obj = json.loads(data.decode("utf-8"))
        return cls(
            bar_offsets={int(k): v for k, v in obj.get("bar_offsets", {}).items()},
            bar_entry_counts={int(k): v for k, v in obj.get("bar_entry_counts", {}).items()},
            type_offsets={int(k): v for k, v in obj.get("type_offsets", {}).items()},
        )


def _json_serializer(obj: Any) -> Any:
    """Custom JSON serializer for Decimal and datetime."""
    if isinstance(obj, Decimal):
        return str(obj)
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


class DebugFileWriter:
    """
    Writer for debug files.

    Appends entries during backtest execution for later analysis.
    """

    def __init__(
        self,
        path: Path | str,
        buffer_size: int = 1000,
    ) -> None:
        """
        Initialize debug file writer.

        Args:
            path: Output file path
            buffer_size: Number of entries to buffer before flushing
        """
        self._path = Path(path)
        self._buffer_size = buffer_size
        self._file: BinaryIO | None = None
        self._buffer: list[DebugEntry] = []
        self._entry_count = 0
        self._index = DebugIndex()
        self._current_offset = HEADER_SIZE

    def open(self) -> None:
        """Open the debug file for writing."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._file = open(self._path, "wb")

        # Write placeholder header (will be updated on close)
        header = struct.pack(
            ">4sIQQQ",
            DEBUG_MAGIC,
            DEBUG_VERSION,
            int(datetime.now().timestamp() * 1000),
            0,  # entry_count placeholder
            0,  # index_offset placeholder
        )
        self._file.write(header)
        self._current_offset = HEADER_SIZE

    def write(self, entry: DebugEntry) -> None:
        """Write an entry to the debug file."""
        if self._file is None:
            raise RuntimeError("Debug file not open")

        self._buffer.append(entry)

        if len(self._buffer) >= self._buffer_size:
            self._flush_buffer()

    def write_bar_start(self, bar_index: int, bar_data: dict[str, Any]) -> None:
        """Write bar start entry."""
        self.write(DebugEntry(
            entry_type=DebugEntryType.BAR_START,
            bar_index=bar_index,
            timestamp=datetime.now().timestamp(),
            data=bar_data,
        ))

    def write_bar_end(self, bar_index: int, state: dict[str, Any]) -> None:
        """Write bar end entry with state snapshot."""
        self.write(DebugEntry(
            entry_type=DebugEntryType.BAR_END,
            bar_index=bar_index,
            timestamp=datetime.now().timestamp(),
            data=state,
        ))

    def write_order_event(
        self,
        bar_index: int,
        event_type: DebugEntryType,
        order_data: dict[str, Any],
    ) -> None:
        """Write order event."""
        self.write(DebugEntry(
            entry_type=event_type,
            bar_index=bar_index,
            timestamp=datetime.now().timestamp(),
            data=order_data,
        ))

    def write_state_snapshot(self, bar_index: int, state: dict[str, Any]) -> None:
        """Write full state snapshot."""
        self.write(DebugEntry(
            entry_type=DebugEntryType.STATE_SNAPSHOT,
            bar_index=bar_index,
            timestamp=datetime.now().timestamp(),
            data=state,
        ))

    def write_marker(self, bar_index: int, label: str, data: dict[str, Any] | None = None) -> None:
        """Write a custom marker/annotation."""
        self.write(DebugEntry(
            entry_type=DebugEntryType.MARKER,
            bar_index=bar_index,
            timestamp=datetime.now().timestamp(),
            data={"label": label, **(data or {})},
        ))

    def _flush_buffer(self) -> None:
        """Flush buffered entries to disk."""
        if not self._buffer or self._file is None:
            return

        for entry in self._buffer:
            entry_bytes = entry.to_bytes()

            # Update index
            if entry.bar_index not in self._index.bar_offsets:
                self._index.bar_offsets[entry.bar_index] = self._current_offset

            self._index.bar_entry_counts[entry.bar_index] = (
                self._index.bar_entry_counts.get(entry.bar_index, 0) + 1
            )

            type_key = entry.entry_type.value
            if type_key not in self._index.type_offsets:
                self._index.type_offsets[type_key] = []
            self._index.type_offsets[type_key].append(self._current_offset)

            # Write entry
            self._file.write(entry_bytes)
            self._current_offset += len(entry_bytes)
            self._entry_count += 1

        self._buffer.clear()

    def close(self) -> None:
        """Close the debug file and finalize index."""
        if self._file is None:
            return

        # Flush remaining buffer
        self._flush_buffer()

        # Write index
        index_offset = self._current_offset
        index_bytes = self._index.to_bytes()
        index_length = len(index_bytes)
        self._file.write(struct.pack(">I", index_length))
        self._file.write(index_bytes)

        # Update header with final counts
        self._file.seek(0)
        header = struct.pack(
            ">4sIQQQ",
            DEBUG_MAGIC,
            DEBUG_VERSION,
            int(datetime.now().timestamp() * 1000),
            self._entry_count,
            index_offset,
        )
        self._file.write(header)

        self._file.close()
        self._file = None

        logger.info(f"Debug file written: {self._path} ({self._entry_count} entries)")

    def __enter__(self) -> "DebugFileWriter":
        """Context manager entry."""
        self.open()
        return self

    def __exit__(self, *args: Any) -> None:
        """Context manager exit."""
        self.close()


class DebugFileReader:
    """
    Memory-mapped reader for debug files.

    Provides efficient random access to large debug files without
    loading the entire file into memory.
    """

    def __init__(self, path: Path | str) -> None:
        """
        Initialize debug file reader.

        Args:
            path: Path to debug file
        """
        self._path = Path(path)
        self._file: BinaryIO | None = None
        self._mmap: mmap.mmap | None = None
        self._entry_count = 0
        self._index_offset = 0
        self._index: DebugIndex | None = None
        self._created_at: datetime | None = None

    @property
    def entry_count(self) -> int:
        """Total number of entries."""
        return self._entry_count

    @property
    def bar_count(self) -> int:
        """Number of bars in the debug file."""
        if self._index is None:
            return 0
        return len(self._index.bar_offsets)

    @property
    def created_at(self) -> datetime | None:
        """When the debug file was created."""
        return self._created_at

    def open(self) -> None:
        """Open the debug file for reading."""
        if not self._path.exists():
            raise FileNotFoundError(f"Debug file not found: {self._path}")

        self._file = open(self._path, "rb")

        # Memory-map the file for efficient access
        self._mmap = mmap.mmap(
            self._file.fileno(),
            0,
            access=mmap.ACCESS_READ,
        )

        # Read header
        header = self._mmap[:HEADER_SIZE]
        magic, version, created_ms, entry_count, index_offset = struct.unpack(
            ">4sIQQQ", header
        )

        if magic != DEBUG_MAGIC:
            raise ValueError(f"Invalid debug file magic: {magic}")

        if version != DEBUG_VERSION:
            raise ValueError(f"Unsupported debug file version: {version}")

        self._entry_count = entry_count
        self._index_offset = index_offset
        self._created_at = datetime.fromtimestamp(created_ms / 1000)

        # Load index
        self._load_index()

        logger.info(
            f"Debug file opened: {self._path} "
            f"({self._entry_count} entries, {self.bar_count} bars)"
        )

    def _load_index(self) -> None:
        """Load the index from the file."""
        if self._mmap is None:
            return

        # Read index length
        index_length = struct.unpack(">I", self._mmap[self._index_offset:self._index_offset + 4])[0]

        # Read index data
        index_data = self._mmap[self._index_offset + 4:self._index_offset + 4 + index_length]
        self._index = DebugIndex.from_bytes(index_data)

    def close(self) -> None:
        """Close the debug file."""
        if self._mmap:
            self._mmap.close()
            self._mmap = None

        if self._file:
            self._file.close()
            self._file = None

    def get_entry_at_offset(self, offset: int) -> DebugEntry:
        """Read an entry at a specific file offset."""
        if self._mmap is None:
            raise RuntimeError("Debug file not open")

        # Read entry header
        header = self._mmap[offset:offset + ENTRY_HEADER_SIZE]
        entry_type, bar_index, length, crc, flags = struct.unpack(">IIIIH2x", header)

        # Read full entry
        entry_data = self._mmap[offset:offset + ENTRY_HEADER_SIZE + length]
        return DebugEntry.from_bytes(entry_data)

    def get_entries_for_bar(self, bar_index: int) -> list[DebugEntry]:
        """Get all entries for a specific bar."""
        if self._index is None:
            return []

        if bar_index not in self._index.bar_offsets:
            return []

        entries = []
        offset = self._index.bar_offsets[bar_index]

        # Read entries until we hit a different bar or end of data
        while offset < self._index_offset:
            try:
                entry = self.get_entry_at_offset(offset)
                if entry.bar_index != bar_index:
                    break
                entries.append(entry)
                # Calculate next entry offset
                entry_bytes = entry.to_bytes()
                offset += len(entry_bytes)
            except Exception:
                break

        return entries

    def get_entries_by_type(
        self,
        entry_type: DebugEntryType,
        limit: int | None = None,
    ) -> list[DebugEntry]:
        """Get entries of a specific type."""
        if self._index is None:
            return []

        offsets = self._index.type_offsets.get(entry_type.value, [])

        if limit:
            offsets = offsets[:limit]

        entries = []
        for offset in offsets:
            try:
                entry = self.get_entry_at_offset(offset)
                entries.append(entry)
            except Exception:
                continue

        return entries

    def get_state_at_bar(self, bar_index: int) -> dict[str, Any] | None:
        """
        Get the state snapshot at a specific bar.

        Looks for BAR_END or STATE_SNAPSHOT entry for the bar.
        """
        entries = self.get_entries_for_bar(bar_index)

        # Look for state snapshot first
        for entry in reversed(entries):
            if entry.entry_type == DebugEntryType.STATE_SNAPSHOT:
                return entry.data
            if entry.entry_type == DebugEntryType.BAR_END:
                return entry.data

        return None

    def iterate_entries(
        self,
        start_bar: int | None = None,
        end_bar: int | None = None,
        entry_types: list[DebugEntryType] | None = None,
    ) -> Iterator[DebugEntry]:
        """
        Iterate through entries with optional filtering.

        Args:
            start_bar: Start from this bar index
            end_bar: Stop at this bar index (exclusive)
            entry_types: Only yield these entry types

        Yields:
            DebugEntry instances
        """
        if self._mmap is None or self._index is None:
            return

        # Get sorted bar indices
        bar_indices = sorted(self._index.bar_offsets.keys())

        if start_bar is not None:
            bar_indices = [b for b in bar_indices if b >= start_bar]

        if end_bar is not None:
            bar_indices = [b for b in bar_indices if b < end_bar]

        type_set = set(entry_types) if entry_types else None

        for bar_index in bar_indices:
            entries = self.get_entries_for_bar(bar_index)
            for entry in entries:
                if type_set is None or entry.entry_type in type_set:
                    yield entry

    def get_summary(self) -> dict[str, Any]:
        """Get summary statistics about the debug file."""
        if self._index is None:
            return {"error": "File not open"}

        type_counts: dict[str, int] = {}
        for type_key, offsets in self._index.type_offsets.items():
            try:
                type_name = DebugEntryType(type_key).name
            except ValueError:
                type_name = f"UNKNOWN_{type_key}"
            type_counts[type_name] = len(offsets)

        bar_indices = sorted(self._index.bar_offsets.keys())

        return {
            "path": str(self._path),
            "created_at": self._created_at.isoformat() if self._created_at else None,
            "entry_count": self._entry_count,
            "bar_count": len(bar_indices),
            "first_bar": bar_indices[0] if bar_indices else None,
            "last_bar": bar_indices[-1] if bar_indices else None,
            "entries_by_type": type_counts,
            "file_size_mb": self._path.stat().st_size / (1024 * 1024),
        }

    def __enter__(self) -> "DebugFileReader":
        """Context manager entry."""
        self.open()
        return self

    def __exit__(self, *args: Any) -> None:
        """Context manager exit."""
        self.close()


class BacktestDebugger:
    """
    High-level debugger for backtest analysis.

    Provides time-travel capabilities and state inspection.
    """

    def __init__(self, debug_file: Path | str) -> None:
        """
        Initialize backtest debugger.

        Args:
            debug_file: Path to debug file
        """
        self._reader = DebugFileReader(debug_file)
        self._current_bar: int = 0

    def open(self) -> None:
        """Open the debug file."""
        self._reader.open()
        if self._reader._index and self._reader._index.bar_offsets:
            self._current_bar = min(self._reader._index.bar_offsets.keys())

    def close(self) -> None:
        """Close the debug file."""
        self._reader.close()

    @property
    def current_bar(self) -> int:
        """Current bar index."""
        return self._current_bar

    @property
    def total_bars(self) -> int:
        """Total number of bars."""
        return self._reader.bar_count

    def goto_bar(self, bar_index: int) -> dict[str, Any] | None:
        """
        Go to a specific bar and return its state.

        Args:
            bar_index: Target bar index

        Returns:
            State at the bar, or None if not found
        """
        self._current_bar = bar_index
        return self._reader.get_state_at_bar(bar_index)

    def step_forward(self) -> dict[str, Any] | None:
        """Move forward one bar and return state."""
        if self._reader._index is None:
            return None

        bar_indices = sorted(self._reader._index.bar_offsets.keys())
        current_idx = (
            bar_indices.index(self._current_bar)
            if self._current_bar in bar_indices
            else -1
        )

        if current_idx < len(bar_indices) - 1:
            self._current_bar = bar_indices[current_idx + 1]

        return self._reader.get_state_at_bar(self._current_bar)

    def step_backward(self) -> dict[str, Any] | None:
        """Move backward one bar and return state."""
        if self._reader._index is None:
            return None

        bar_indices = sorted(self._reader._index.bar_offsets.keys())
        current_idx = (
            bar_indices.index(self._current_bar)
            if self._current_bar in bar_indices
            else len(bar_indices)
        )

        if current_idx > 0:
            self._current_bar = bar_indices[current_idx - 1]

        return self._reader.get_state_at_bar(self._current_bar)

    def get_orders_at_bar(self, bar_index: int | None = None) -> list[dict[str, Any]]:
        """Get order events at a bar."""
        bar = bar_index if bar_index is not None else self._current_bar
        entries = self._reader.get_entries_for_bar(bar)

        order_types = {
            DebugEntryType.ORDER_SUBMITTED,
            DebugEntryType.ORDER_FILLED,
            DebugEntryType.ORDER_CANCELLED,
            DebugEntryType.ORDER_REJECTED,
        }

        return [e.to_dict() for e in entries if e.entry_type in order_types]

    def find_order(self, order_id: str) -> list[DebugEntry]:
        """Find all entries related to an order."""
        results = []

        for entry_type in [
            DebugEntryType.ORDER_SUBMITTED,
            DebugEntryType.ORDER_FILLED,
            DebugEntryType.ORDER_CANCELLED,
            DebugEntryType.ORDER_REJECTED,
        ]:
            entries = self._reader.get_entries_by_type(entry_type)
            for entry in entries:
                if entry.data.get("order_id") == order_id:
                    results.append(entry)

        return sorted(results, key=lambda e: e.bar_index)

    def get_equity_curve(self) -> list[tuple[int, float]]:
        """Extract equity curve from snapshots."""
        snapshots = self._reader.get_entries_by_type(DebugEntryType.EQUITY_SNAPSHOT)
        curve = []

        for entry in snapshots:
            equity = entry.data.get("equity")
            if equity is not None:
                curve.append((entry.bar_index, float(equity)))

        return curve

    def get_markers(self) -> list[DebugEntry]:
        """Get all markers/annotations."""
        return self._reader.get_entries_by_type(DebugEntryType.MARKER)

    def summary(self) -> dict[str, Any]:
        """Get debugger summary."""
        return {
            "current_bar": self._current_bar,
            "file_summary": self._reader.get_summary(),
        }

    def __enter__(self) -> "BacktestDebugger":
        """Context manager entry."""
        self.open()
        return self

    def __exit__(self, *args: Any) -> None:
        """Context manager exit."""
        self.close()
