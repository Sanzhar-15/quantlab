"""Test fixture: writes the banner, then exits non-zero. Drives the
DaemonLifecycle's "ready -> crashed -> respawning -> ready" path."""
import json
import os
import struct
import sys
import time

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
    # The lifecycle test sets QVIZ_FIXTURE_CRASH_AFTER_MS to control how
    # long this fake daemon stays "alive" before exiting. The first
    # spawn of a test usually wants a quick crash so the respawn timer
    # fires; later spawns want a long uptime so the test asserts ready.
    delay_ms = int(os.environ.get("QVIZ_FIXTURE_CRASH_AFTER_MS", "50"))
    time.sleep(delay_ms / 1000)
    sys.exit(2)


if __name__ == "__main__":
    main()
