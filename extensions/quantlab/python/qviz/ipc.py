"""IPC protocol framing for the qviz query daemon (over stdio).

Frame format (little-endian, length-prefixed):

  +-----------+-----------+--------+----------+
  | uint32 LE | uint8     | uint8  | bytes... |
  | length    | type tag  | resv.  | payload  |
  +-----------+-----------+--------+----------+

  length    : payload size in bytes (NOT including the 6-byte header)
  type tag  : 0x01 = JSON UTF-8, 0x02 = Apache Arrow IPC stream
  resv.     : reserved (must be 0); future versions may use as flag bits
  payload   : `length` bytes

Why length-prefixed instead of NDJSON? The spike used line-delimited JSON
which is fine for small messages but breaks when payloads contain newlines
(e.g. data values with embedded \\n) and is awkward for binary Arrow frames.
A 6-byte header costs nothing per message and lets us mix JSON + Arrow on
the same channel.

Why little-endian? Matches every modern target host. Documented explicitly
to avoid endianness bugs.

Maximum frame size is bounded to defend against malformed input that would
otherwise allocate huge buffers.
"""

from __future__ import annotations

import json
import struct
from io import BufferedReader, BufferedWriter
from typing import Any


# Frame type tags
FRAME_JSON = 0x01
FRAME_ARROW_IPC = 0x02

# Hard cap on incoming frame size. Outgoing frames have their own caps in
# the daemon; this one protects the daemon from a malicious or buggy client
# sending a 4 GiB length prefix.
MAX_FRAME_BYTES = 64 * 1024 * 1024  # 64 MB

# Header: <uint32 length, uint8 type, uint8 reserved>
HEADER_FMT = "<IBB"
HEADER_SIZE = 6


class IPCError(Exception):
    """Protocol-level error: malformed header, oversized frame, EOF in middle."""


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def read_frame(reader: BufferedReader) -> tuple[int, bytes]:
    """Read one frame. Returns (type_tag, payload_bytes).

    Raises IPCError on malformed/oversized frames or unexpected EOF.
    Returns (None, None) on clean EOF before any header bytes.
    """
    header = _read_exactly(reader, HEADER_SIZE)
    if header is None:
        # Clean shutdown — peer closed stdin.
        raise EOFError("peer closed connection")
    length, type_tag, reserved = struct.unpack(HEADER_FMT, header)
    if reserved != 0:
        raise IPCError(f"frame reserved byte must be 0, got {reserved}")
    if length > MAX_FRAME_BYTES:
        raise IPCError(f"frame too large: {length} > {MAX_FRAME_BYTES}")
    if length == 0:
        return type_tag, b""
    payload = _read_exactly(reader, length)
    if payload is None:
        raise IPCError(f"incomplete frame: header announced {length} bytes")
    return type_tag, payload


def read_json(reader: BufferedReader) -> Any:
    """Convenience: read one JSON frame, return the decoded object.

    Raises IPCError if frame type is not JSON.
    """
    tag, payload = read_frame(reader)
    if tag != FRAME_JSON:
        raise IPCError(f"expected JSON frame (tag {FRAME_JSON}), got tag {tag}")
    return json.loads(payload.decode("utf-8"))


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


def write_frame(writer: BufferedWriter, type_tag: int, payload: bytes) -> None:
    """Write one frame to the writer. Caller must flush() if needed."""
    if len(payload) > MAX_FRAME_BYTES:
        raise IPCError(f"outbound frame too large: {len(payload)} > {MAX_FRAME_BYTES}")
    if type_tag not in (FRAME_JSON, FRAME_ARROW_IPC):
        raise IPCError(f"unknown frame type: {type_tag}")
    header = struct.pack(HEADER_FMT, len(payload), type_tag, 0)
    writer.write(header)
    writer.write(payload)


def write_json(writer: BufferedWriter, obj: Any) -> None:
    payload = json.dumps(obj, default=_default_json).encode("utf-8")
    write_frame(writer, FRAME_JSON, payload)


def write_arrow(writer: BufferedWriter, arrow_bytes: bytes) -> None:
    write_frame(writer, FRAME_ARROW_IPC, arrow_bytes)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _read_exactly(reader: BufferedReader, n: int) -> bytes | None:
    """Read exactly n bytes or return None on clean EOF.

    Raises IPCError on partial read (EOF mid-message).
    """
    chunks: list[bytes] = []
    remaining = n
    while remaining > 0:
        chunk = reader.read(remaining)
        if not chunk:
            if not chunks:
                return None  # clean EOF before any data
            raise IPCError(f"EOF after reading {n - remaining} of {n} bytes")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _default_json(o: Any) -> Any:
    """JSON encoder fallback for non-serializable types we encounter."""
    if hasattr(o, "isoformat"):
        return o.isoformat()
    raise TypeError(f"object of type {type(o).__name__} is not JSON serializable")
