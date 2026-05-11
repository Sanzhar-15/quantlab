"""Test fixture: writes banner + arrow-encoded JSON head, then exits.

Exercises QvizDaemonClient's mid-arrow daemon-death recovery (AF3).
The TS client must reject the in-flight aggregate promise even though
the pending request was parked in `awaitingArrowFor` at the moment of
exit.
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
    write_json(out, {"daemon": "qviz", "version": 1, "ops": ["ping", "aggregate"]})

    # Read one request (consume header + payload), then write a JSON head
    # advertising encoding=arrow but DO NOT write the follow-up frame --
    # exit instead. The client must reject the corresponding promise.
    in_ = sys.stdin.buffer
    header = in_.read(6)
    if len(header) != 6:
        return
    length, _, _ = struct.unpack(HEADER_FMT, header)
    payload = in_.read(length)
    req = json.loads(payload.decode("utf-8"))
    write_json(out, {
        "id": req.get("id"),
        "ok": True,
        "data": {"n": 100, "bytes": 0, "columns": ["x"]},
        "encoding": "arrow",
        "elapsed_ms": 1.0,
    })
    # Exit without writing the follow-up Arrow frame.


if __name__ == "__main__":
    main()
