"""Test fixture: writes banner and stays alive (reads stdin into the
void) so the lifecycle can transition to 'ready' and stay there while
the test issues a request or asserts status."""
import json
import struct
import sys

FRAME_JSON = 0x01
HEADER_FMT = "<IBB"


def write_json(out, obj):
    payload = json.dumps(obj).encode("utf-8")
    out.write(struct.pack(HEADER_FMT, len(payload), FRAME_JSON, 0))
    out.write(payload)
    out.flush()


def main() -> None:
    out = sys.stdout.buffer
    write_json(out, {"daemon": "qviz", "version": 1, "ops": ["ping"]})
    # Read stdin to the void; if the parent closes stdin (dispose), exit cleanly.
    while True:
        data = sys.stdin.buffer.read(4096)
        if not data:
            return


if __name__ == "__main__":
    main()
