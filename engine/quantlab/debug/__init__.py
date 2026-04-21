"""
Time-travel debugger module.

Provides:
- Apache Arrow IPC debug file format
- Bar state snapshots
- Condition capture
- Random access indexing
- Memory-mapped file access
"""

from .format import (
    SCHEMA_VERSION,
    BarState,
    ConditionCapture,
    DebugFileReader,
    DebugFileWriter,
    DebugMetadata,
)
from .capture import (
    CaptureContext,
    ConditionCapturer,
    ConditionInstrumentor,
    create_capture_wrapper,
    instrument_code,
)
from .index import (
    BarIndex,
    DebugIndex,
    DebugIndexBuilder,
    load_index,
    save_index,
)

__all__ = [
    # Format
    "SCHEMA_VERSION",
    "BarState",
    "ConditionCapture",
    "DebugFileReader",
    "DebugFileWriter",
    "DebugMetadata",
    # Capture
    "CaptureContext",
    "ConditionCapturer",
    "ConditionInstrumentor",
    "create_capture_wrapper",
    "instrument_code",
    # Index
    "BarIndex",
    "DebugIndex",
    "DebugIndexBuilder",
    "load_index",
    "save_index",
]
