"""Test-only fixture worker that FLOODS the engine with nonterminal frames on a CALL — it
performs the HELLO/HELLO_ACK handshake normally, then on the first CALL emits an endless stream
of RETURN frames carrying a STALE ``call_id`` (0, which never matches the engine's call_ids that
start at 1) and NEVER the correlated result.

The engine must still hard-cancel on its per-call deadline: `recv_timeout` returns a ready frame
immediately, so without a top-of-loop deadline guard the engine's `call()` loop would `continue`
forever and the deadline would never fire (6.4-3b audit-fix: frame-flood-defeats-timeout /
contract §10.4 exit test 6). Stale RETURNs (not LOG) are used so the engine's skip path is silent
— no `eprintln!` spam during the flood.

NOT part of the product surface — only `ql-udf/tests/process_smoke.rs` points a worker at it.
"""

import os
import sys

from quantbook import _codec, _frame


def main():
    # Reserve the protocol fd exactly like the real worker (defensive: keep any pyarrow/import
    # chatter off the frame stream).
    proto_fd = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    proto = os.fdopen(proto_fd, "wb", buffering=0)

    stdin = sys.stdin.buffer
    # A valid RETURN payload with call_id=0 (never matches an engine call_id) — precomputed once.
    stale_return = _codec.encode_return(0, _codec.Grid.scalar(1.0))
    while True:
        f = _frame.read_frame(stdin)
        if f is None:
            return 0
        ftype, _payload = f
        if ftype == _frame.HELLO:
            _frame.write_frame(proto, _frame.HELLO_ACK, _codec.encode_hello_ack(1, os.getpid()))
        elif ftype == _frame.CALL:
            try:
                while True:
                    _frame.write_frame(proto, _frame.RETURN, stale_return)
            except (BrokenPipeError, OSError):
                return 0  # engine hard-cancelled us / closed the pipe


if __name__ == "__main__":
    sys.exit(main())
