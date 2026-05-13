"""Test fixture: replies to a request with an `ok:false` response whose
`error_kind` is unknown to the TS-side decoder. Exercises megaudit F3:
the strict decoder must reject the kind with DaemonProtocolError and
trip failPending (fatalising the client) rather than silently
classifying as `'compile'`.

Behavior:
  1. Write banner.
  2. Read first request (id N).
  3. Reply with id=N, ok:false, error_kind="compiler" (rename drift).
"""
import json
import struct
import sys
import time


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
    payload = in_.read(length)
    req = json.loads(payload.decode("utf-8"))
    write_json(out, {
        "id": req.get("id"),
        "ok": False,
        "error": "deliberately misclassified",
        "error_kind": "compiler",   # NOT in DAEMON_ERROR_KINDS — rename drift
        "elapsed_ms": 1.0,
    })
    # Stay alive briefly so the client has time to react before stdin closes.
    time.sleep(2)


if __name__ == "__main__":
    main()
