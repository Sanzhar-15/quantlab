"""Test fixture: a daemon that intentionally never writes a banner.

Used to exercise QvizDaemonClient.ready()'s banner timeout path. The
process stays alive (reads stdin into the void) so the client doesn't
fall through into the "process exited" close path; it must hit the
explicit timeout.
"""
import sys
import time

# Read stdin to /dev/null so the parent's stdin.write() doesn't block
# on a full pipe buffer.
def main() -> None:
    while True:
        data = sys.stdin.buffer.read(4096)
        if not data:
            break
        # discard
        time.sleep(0.01)


if __name__ == "__main__":
    main()
