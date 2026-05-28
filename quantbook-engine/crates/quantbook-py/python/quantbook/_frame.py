"""UDF wire envelope — the Python mirror of `ql-udf/src/frame.rs`.

Frame layout: ``[u32 LE total_len][u8 frame_type][payload...]`` where
``total_len == 1 + len(payload)`` (the type byte counts). All integers are
little-endian. 3.9-compatible.

This is the worker side of the protocol the Rust engine (`ql-udf::ProcessWorker`)
speaks over stdio. Every malformed frame raises loudly — never a silent skip.
"""

import struct

# Frame type tags — MUST match `ql-udf/src/frame.rs::FrameType` exactly.
HELLO = 1
HELLO_ACK = 2
CALL = 3
RETURN = 4
RAISE = 5
CANCEL = 6
LOG = 7

# Sanity cap, mirroring `ql-udf::frame::MAX_FRAME_LEN` (64 MiB).
MAX_FRAME_LEN = 64 * 1024 * 1024


def _read_n(stream, n):
    """Read exactly ``n`` bytes from ``stream``.

    Returns the bytes, or ``None`` if EOF occurs *before any byte* (a clean
    shutdown between frames). Raises ``EOFError`` on a partial read (torn frame).
    """
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            if not buf:
                return None
            raise EOFError("torn frame: read %d of %d bytes" % (len(buf), n))
        buf.extend(chunk)
    return bytes(buf)


def read_frame(stream):
    """Read one frame. Returns ``(frame_type, payload_bytes)`` or ``None`` on a
    clean EOF between frames. Raises on a torn / zero-length / oversized frame."""
    head = _read_n(stream, 4)
    if head is None:
        return None  # clean EOF between frames
    total = struct.unpack("<I", head)[0]
    if total == 0:
        raise ValueError("zero-length frame (need at least the 1-byte type tag)")
    if total > MAX_FRAME_LEN:
        raise ValueError("frame length %d exceeds the %d-byte cap" % (total, MAX_FRAME_LEN))
    body = _read_n(stream, total)
    if body is None:
        raise EOFError("torn frame: EOF before the %d-byte body" % total)
    frame_type = body[0]
    payload = body[1:]
    return (frame_type, payload)


def write_frame(stream, frame_type, payload):
    """Write one frame and flush. ``payload`` is ``bytes``."""
    total = 1 + len(payload)
    if total > MAX_FRAME_LEN:
        raise ValueError("frame length %d exceeds the %d-byte cap" % (total, MAX_FRAME_LEN))
    stream.write(struct.pack("<I", total))
    stream.write(bytes([frame_type]))
    if payload:
        stream.write(payload)
    stream.flush()
