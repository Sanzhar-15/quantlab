"""``python -m quantbook.worker`` — the out-of-process UDF worker loop. 6.4-3b.

Speaks the `ql-udf` wire protocol over a RESERVED protocol fd (the original stdout): reads
frames from **stdin**, replies on that protocol fd. The protocol fd is reserved EXCLUSIVELY for
frames — `main()` repoints fd 1 and ``sys.stdout`` at stderr BEFORE importing any user code, so a
stray ``print()`` in a UDF (or import-time chatter) goes to stderr instead of corrupting the frame
stream (6.4-3b audit-fix: udf-print-corrupts-protocol-stdout).

The engine (`ql-udf::ProcessWorker`) spawns this, performs the HELLO/HELLO_ACK handshake, and
sends one CALL per UDF invocation. UDFs are registered by handle via
`quantbook.register_formula_function`; the trusted user module that does the registering is named
by ``QUANTBOOK_UDF_MODULE`` and imported once at startup (its import side-effects populate the
registry).
"""

import importlib
import os
import struct
import sys

from . import _codec, _frame, _registry

# Wire protocol version — MUST match `ql-udf::control::PROTOCOL_VERSION`.
PROTOCOL_VERSION = 1


def _import_udf_module():
    """Import the trusted user module (registers UDFs by handle) if configured."""
    mod = os.environ.get("QUANTBOOK_UDF_MODULE")
    if mod:
        importlib.import_module(mod)


def run(stdin, stdout, stderr):
    """The worker loop. ``stdout`` is the RESERVED protocol writer. Returns 0 when the engine
    closes stdin (clean shutdown) or the protocol pipe (engine gone)."""
    _import_udf_module()
    try:
        while True:
            frame = _frame.read_frame(stdin)
            if frame is None:
                return 0  # engine closed stdin → clean exit
            ftype, payload = frame
            if ftype == _frame.HELLO:
                # Validate the HELLO shape; the engine decides version compatibility from our
                # ack. Reply with OUR protocol version + pid (pid → IDE debugpy, 6.4-3d).
                _codec.decode_hello(payload)
                _frame.write_frame(
                    stdout, _frame.HELLO_ACK, _codec.encode_hello_ack(PROTOCOL_VERSION, os.getpid())
                )
            elif ftype == _frame.CALL:
                # Decode the fixed 16-byte [handle][call_id] header OUTSIDE the try so we always
                # have a call_id to correlate a failure. If even the header is unreadable we
                # cannot address a RAISE — log to stderr and continue rather than crashing the
                # loop (6.4-3b audit-fix: malformed-call-decode-crashes-loop-no-raise).
                if len(payload) < 16:
                    stderr.write(
                        "quantbook.worker: dropping CALL with truncated %d-byte header\n"
                        % len(payload)
                    )
                    stderr.flush()
                    continue
                handle, call_id = struct.unpack("<QQ", payload[:16])
                try:
                    # Grid-decode is INSIDE the try: a malformed args grid becomes a RAISE
                    # correlated to call_id, not a loop-killing crash.
                    args = _codec.decode_grid(payload[16:])
                    fn = _registry.lookup(handle)
                    if fn is None:
                        raise LookupError("no UDF registered for handle %d" % handle)
                    result = _codec.as_grid(fn(args))
                    _frame.write_frame(stdout, _frame.RETURN, _codec.encode_return(call_id, result))
                except Exception as e:  # noqa: BLE001 — ANY UDF/arg failure → RAISE, never crashes the loop
                    _frame.write_frame(
                        stdout, _frame.RAISE, _codec.encode_raise(call_id, type(e).__name__, str(e))
                    )
            elif ftype == _frame.CANCEL:
                # Cooperative cancel: v1 best-effort no-op (the loop is busy inside the UDF when a
                # CANCEL would arrive, so it isn't even read mid-call). Hard cancel = the engine
                # SIGKILLs this process (the worker is designed to be killable mid-call).
                pass
            else:
                stderr.write("quantbook.worker: ignoring unexpected frame type %d\n" % ftype)
                stderr.flush()
    except BrokenPipeError:
        # The engine closed the protocol pipe (process gone). A clean shutdown, NOT an error to
        # report — there is nobody left to report it to (6.4-3b audit-fix:
        # hello-ack-broken-pipe-uncaught-during-handshake).
        stderr.write("quantbook.worker: protocol pipe closed by engine; exiting\n")
        stderr.flush()
        return 0


def main():
    # Reserve fd 1 EXCLUSIVELY for the wire protocol (6.4-3b audit-fix:
    # udf-print-corrupts-protocol-stdout). Dup the real stdout (the engine's pipe) to a private
    # fd, then repoint fd 1 and Python-level sys.stdout at stderr so ANY user `print()` / library
    # stdout write / import-time chatter goes to stderr instead of corrupting the frame stream.
    # This MUST happen before `run()` imports user UDF code.
    proto_fd = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    proto = os.fdopen(proto_fd, "wb", buffering=0)
    try:
        return run(sys.stdin.buffer, proto, sys.stderr)
    finally:
        try:
            proto.close()
        except BrokenPipeError:
            pass  # engine already gone — nothing to flush


if __name__ == "__main__":
    sys.exit(main())
