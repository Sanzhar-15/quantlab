"""Test fixture: replies with a WRONG id, exercising AF4 (protocol desync).

The TS client should treat an id mismatch as fatal and drain ALL pending
requests, not just the head. This fixture's behavior:
  1. Write banner.
  2. Read first request (real id N).
  3. Reply with id=999999999 (intentional desync).

The client should then reject every queued request.
"""
import json
import struct
import sys


HEADER_FMT = "<IBB"
FRAME_JSON = 0x01


def write_json(out, obj):
    payload = json.dumps(obj).encode("utf-8")
    out.write(struct.pack(HEADER_FMT, len(payload), FRAME_JSON, 0))
    out.write(payload)
    out.flush()


def main() -> None:
    out = sys.stdout.buffer
    write_json(out, {"daemon": "qviz", "version": 1, "ops": ["ping"]})

    in_ = sys.stdin.buffer
    header = in_.read(6)
    if len(header) != 6:
        return
    length, _, _ = struct.unpack(HEADER_FMT, header)
    in_.read(length)
    write_json(out, {
        "id": 999_999_999,  # Intentional desync.
        "ok": True,
        "data": {"pong": True, "workspace": "/tmp"},
        "encoding": "json",
        "elapsed_ms": 1.0,
    })
    # Stay alive briefly so the client has time to act on the bad reply
    # before stdin closes.
    import time
    time.sleep(2)


if __name__ == "__main__":
    main()
