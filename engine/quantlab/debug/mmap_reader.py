"""
Memory-mapped Debug File Reader (FIX-CGP-017).

Provides O(1) random access to debug state at any bar index using memory mapping.

This is efficient for large debug files as it doesn't load the entire file into
memory, instead using the OS virtual memory system for on-demand page loading.

Spec Reference: Technical Spec §10.2
"""

import json
import logging
import mmap
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from typing import Iterator

try:
    import pyarrow as pa
    import pyarrow.ipc as ipc
    HAS_ARROW = True
except ImportError:
    HAS_ARROW = False


logger = logging.getLogger(__name__)


@dataclass
class DebugState:
    """State snapshot at a specific bar."""

    bar_index: int
    timestamp: datetime
    portfolio: dict[str, Any]
    positions: dict[str, Any]
    signals: dict[str, Any]
    conditions: dict[str, Any]
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "bar_index": self.bar_index,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "portfolio": self.portfolio,
            "positions": self.positions,
            "signals": self.signals,
            "conditions": self.conditions,
            "metadata": self.metadata,
        }


class DebugMmapReader:
    """
    Memory-mapped reader for debug files supporting O(1) random bar access.

    Uses mmap for efficient random access without loading entire file.
    Supports both Arrow IPC format and JSON-lines format.

    Usage:
        with DebugMmapReader(Path("debug.arrow")) as reader:
            # O(1) access to any bar
            state = reader.get_state_at_bar(500)
            print(state.portfolio)

            # Iterate efficiently
            for state in reader.iter_states(start=100, end=200):
                process(state)
    """

    def __init__(self, debug_file: Path | str) -> None:
        """
        Initialize mmap reader.

        Args:
            debug_file: Path to debug file (.arrow or .jsonl)
        """
        self._path = Path(debug_file)
        self._file = None
        self._mmap = None
        self._index: dict[int, int] = {}  # bar_index -> file_offset or batch_number
        self._format: str = "unknown"
        self._total_bars: int = 0

        # Arrow-specific
        self._arrow_reader = None
        self._schema = None

    @property
    def total_bars(self) -> int:
        """Total number of bars in file."""
        return self._total_bars

    @property
    def bar_indices(self) -> list[int]:
        """List of available bar indices."""
        return sorted(self._index.keys())

    def open(self) -> None:
        """Open the debug file and build index."""
        if not self._path.exists():
            raise FileNotFoundError(f"Debug file not found: {self._path}")

        suffix = self._path.suffix.lower()

        if suffix == ".arrow" and HAS_ARROW:
            self._open_arrow()
        elif suffix in (".jsonl", ".json"):
            self._open_jsonl()
        else:
            # Try Arrow first, fall back to JSONL
            if HAS_ARROW:
                try:
                    self._open_arrow()
                except Exception:
                    self._open_jsonl()
            else:
                self._open_jsonl()

        logger.info(
            f"Opened debug file: {self._path} ({self._format}, {self._total_bars} bars)"
        )

    def _open_arrow(self) -> None:
        """Open as Arrow IPC file."""
        self._file = open(self._path, "rb")
        self._mmap = mmap.mmap(self._file.fileno(), 0, access=mmap.ACCESS_READ)
        self._format = "arrow"

        # Build index from Arrow file
        self._arrow_reader = ipc.open_file(self._mmap)
        self._schema = self._arrow_reader.schema

        for batch_num in range(self._arrow_reader.num_record_batches):
            batch = self._arrow_reader.get_batch(batch_num)
            if "bar_index" in batch.schema.names:
                bar_indices = batch.column("bar_index").to_pylist()
                for bar_idx in bar_indices:
                    self._index[bar_idx] = batch_num

        self._total_bars = len(self._index)

    def _open_jsonl(self) -> None:
        """Open as JSON-lines file."""
        self._file = open(self._path, "rb")
        self._mmap = mmap.mmap(self._file.fileno(), 0, access=mmap.ACCESS_READ)
        self._format = "jsonl"

        # Build index by scanning line offsets
        offset = 0
        while offset < self._mmap.size():
            line_end = self._mmap.find(b"\n", offset)
            if line_end == -1:
                line_end = self._mmap.size()

            line = self._mmap[offset:line_end]
            if line.strip():
                try:
                    data = json.loads(line.decode("utf-8"))
                    bar_idx = data.get("bar_index", self._total_bars)
                    self._index[bar_idx] = offset
                    self._total_bars += 1
                except json.JSONDecodeError:
                    pass

            offset = line_end + 1

    def close(self) -> None:
        """Close the mmap and file."""
        if self._mmap:
            self._mmap.close()
            self._mmap = None
        if self._file:
            self._file.close()
            self._file = None
        self._arrow_reader = None
        self._index.clear()
        self._total_bars = 0

    def get_state_at_bar(self, bar_index: int) -> DebugState:
        """
        O(1) random access to state at a specific bar.

        Args:
            bar_index: Bar index to retrieve

        Returns:
            DebugState at that bar

        Raises:
            KeyError: If bar index not found
        """
        if bar_index not in self._index:
            raise KeyError(f"Bar {bar_index} not found in debug file")

        if self._format == "arrow":
            return self._get_arrow_state(bar_index)
        else:
            return self._get_jsonl_state(bar_index)

    def _get_arrow_state(self, bar_index: int) -> DebugState:
        """Get state from Arrow file."""
        batch_num = self._index[bar_index]
        batch = self._arrow_reader.get_batch(batch_num)

        # Find row within batch
        bar_col = batch.column("bar_index").to_pylist()
        row_idx = bar_col.index(bar_index)

        return DebugState(
            bar_index=bar_index,
            timestamp=self._get_column_value(batch, "timestamp", row_idx),
            portfolio=self._parse_json_column(batch, "portfolio", row_idx),
            positions=self._parse_json_column(batch, "positions", row_idx),
            signals=self._parse_json_column(batch, "signals", row_idx),
            conditions=self._parse_json_column(batch, "conditions", row_idx),
            metadata=self._parse_json_column(batch, "metadata", row_idx),
        )

    def _get_column_value(self, batch, col_name: str, row_idx: int) -> Any:
        """Get value from column if it exists."""
        if col_name in batch.schema.names:
            value = batch.column(col_name)[row_idx].as_py()
            # Convert timestamp types
            if hasattr(value, "to_pydatetime"):
                return value.to_pydatetime()
            return value
        return None

    def _parse_json_column(self, batch, col_name: str, row_idx: int) -> dict[str, Any]:
        """Parse JSON from column if it exists."""
        if col_name in batch.schema.names:
            value = batch.column(col_name)[row_idx].as_py()
            if isinstance(value, str):
                try:
                    return json.loads(value)
                except json.JSONDecodeError:
                    return {"raw": value}
            elif isinstance(value, dict):
                return value
        return {}

    def _get_jsonl_state(self, bar_index: int) -> DebugState:
        """Get state from JSONL file."""
        offset = self._index[bar_index]

        # Read line at offset
        line_end = self._mmap.find(b"\n", offset)
        if line_end == -1:
            line_end = self._mmap.size()

        line = self._mmap[offset:line_end].decode("utf-8")
        data = json.loads(line)

        timestamp = None
        if "timestamp" in data:
            ts = data["timestamp"]
            if isinstance(ts, str):
                try:
                    timestamp = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except ValueError:
                    pass

        return DebugState(
            bar_index=data.get("bar_index", bar_index),
            timestamp=timestamp,
            portfolio=data.get("portfolio", {}),
            positions=data.get("positions", {}),
            signals=data.get("signals", {}),
            conditions=data.get("conditions", {}),
            metadata=data.get("metadata"),
        )

    def iter_states(
        self,
        start: int | None = None,
        end: int | None = None,
    ) -> Iterator[DebugState]:
        """
        Iterate over states in bar order.

        Args:
            start: Starting bar index (inclusive)
            end: Ending bar index (inclusive)

        Yields:
            DebugState for each bar in range
        """
        indices = sorted(self._index.keys())

        for bar_idx in indices:
            if start is not None and bar_idx < start:
                continue
            if end is not None and bar_idx > end:
                break
            yield self.get_state_at_bar(bar_idx)

    def __enter__(self) -> "DebugMmapReader":
        """Context manager entry."""
        self.open()
        return self

    def __exit__(self, *args) -> None:
        """Context manager exit."""
        self.close()

    def __len__(self) -> int:
        """Number of bars in file."""
        return self._total_bars

    def __contains__(self, bar_index: int) -> bool:
        """Check if bar index exists."""
        return bar_index in self._index
