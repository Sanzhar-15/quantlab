"""Tests for IPC framing.

We use io.BytesIO to simulate the stdio reader/writer endpoints.
"""

from __future__ import annotations

import io
import struct

import pytest

from qviz.ipc import (
    FRAME_ARROW_IPC,
    FRAME_JSON,
    HEADER_SIZE,
    IPCError,
    MAX_FRAME_BYTES,
    read_frame,
    read_json,
    write_arrow,
    write_frame,
    write_json,
)


def _round_trip_writer() -> tuple[io.BufferedWriter, io.BufferedReader]:
    """Build a connected writer/reader pair backed by an in-memory pipe."""
    buf = io.BytesIO()
    return buf, buf  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Round-trip
# ---------------------------------------------------------------------------


def test_json_round_trip() -> None:
    buf = io.BytesIO()
    obj = {"id": 1, "op": "ping"}
    write_json(buf, obj)
    buf.seek(0)
    decoded = read_json(buf)
    assert decoded == obj


def test_json_round_trip_unicode() -> None:
    buf = io.BytesIO()
    obj = {"name": "汉语", "value": 42}
    write_json(buf, obj)
    buf.seek(0)
    decoded = read_json(buf)
    assert decoded == obj


def test_json_round_trip_with_datetime() -> None:
    """The default fallback serializes datetimes via .isoformat()."""
    import datetime as dt
    buf = io.BytesIO()
    obj = {"when": dt.datetime(2026, 4, 29, 12, 0, 0)}
    write_json(buf, obj)
    buf.seek(0)
    decoded = read_json(buf)
    assert decoded["when"] == "2026-04-29T12:00:00"


def test_arrow_frame_round_trip() -> None:
    buf = io.BytesIO()
    arrow_bytes = b"\x00\x01\x02\x03\xff\xfe"  # opaque payload
    write_arrow(buf, arrow_bytes)
    buf.seek(0)
    tag, payload = read_frame(buf)
    assert tag == FRAME_ARROW_IPC
    assert payload == arrow_bytes


def test_multiple_frames_in_order() -> None:
    buf = io.BytesIO()
    write_json(buf, {"a": 1})
    write_json(buf, {"b": 2})
    write_arrow(buf, b"binary")
    buf.seek(0)
    assert read_json(buf) == {"a": 1}
    assert read_json(buf) == {"b": 2}
    tag, payload = read_frame(buf)
    assert tag == FRAME_ARROW_IPC
    assert payload == b"binary"


def test_eof_before_any_header() -> None:
    buf = io.BytesIO(b"")
    with pytest.raises(EOFError):
        read_frame(buf)


def test_partial_header_raises() -> None:
    buf = io.BytesIO(b"\x05\x00\x00")  # only 3 of 6 header bytes
    with pytest.raises(IPCError, match="EOF"):
        read_frame(buf)


def test_partial_payload_raises() -> None:
    # Header announces 100 bytes, but only 50 follow.
    header = struct.pack("<IBB", 100, FRAME_JSON, 0)
    buf = io.BytesIO(header + b"x" * 50)
    with pytest.raises(IPCError, match="EOF after reading"):
        read_frame(buf)


def test_oversized_frame_rejected() -> None:
    header = struct.pack("<IBB", MAX_FRAME_BYTES + 1, FRAME_JSON, 0)
    buf = io.BytesIO(header)
    with pytest.raises(IPCError, match="too large"):
        read_frame(buf)


def test_reserved_byte_must_be_zero() -> None:
    header = struct.pack("<IBB", 0, FRAME_JSON, 99)
    buf = io.BytesIO(header)
    with pytest.raises(IPCError, match="reserved"):
        read_frame(buf)


def test_unknown_frame_type_on_write() -> None:
    buf = io.BytesIO()
    with pytest.raises(IPCError, match="unknown frame type"):
        write_frame(buf, 0xFF, b"")


def test_oversized_outbound_rejected() -> None:
    buf = io.BytesIO()
    with pytest.raises(IPCError, match="too large"):
        write_frame(buf, FRAME_JSON, b"x" * (MAX_FRAME_BYTES + 1))


def test_zero_length_payload() -> None:
    """Frame with length=0 is valid (e.g. JSON 'null' payload, though 'null' is 4 bytes —
    a truly empty JSON-tagged frame would be a protocol error semantically but the
    framing layer must let it through; the JSON decoder above raises on empty)."""
    buf = io.BytesIO()
    write_frame(buf, FRAME_ARROW_IPC, b"")
    buf.seek(0)
    tag, payload = read_frame(buf)
    assert tag == FRAME_ARROW_IPC
    assert payload == b""


def test_read_json_rejects_non_json_tag() -> None:
    buf = io.BytesIO()
    write_arrow(buf, b"not json")
    buf.seek(0)
    with pytest.raises(IPCError, match="expected JSON"):
        read_json(buf)


def test_header_size_constant_matches_struct() -> None:
    assert struct.calcsize("<IBB") == HEADER_SIZE


def test_large_but_valid_frame() -> None:
    """Write/read a 1 MB frame to confirm we don't choke on legitimate sizes."""
    buf = io.BytesIO()
    payload = b"x" * (1 * 1024 * 1024)
    write_frame(buf, FRAME_ARROW_IPC, payload)
    buf.seek(0)
    tag, got = read_frame(buf)
    assert tag == FRAME_ARROW_IPC
    assert len(got) == len(payload)
