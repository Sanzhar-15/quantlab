"""``python -m quantbook.worker`` — the out-of-process UDF worker loop. 6.4-3b.

Speaks the `ql-udf` wire protocol over stdio: reads frames from **stdin**, replies
on **stdout**. stdout is the PROTOCOL channel — the worker must NEVER print to it;
diagnostics go to stderr. The engine (`ql-udf::ProcessWorker`) spawns this, performs
the HELLO/HELLO_ACK handshake, and sends one CALL per UDF invocation.

UDFs are registered by handle via `quantbook.register_formula_function`. The trusted
user module that does the registering is named by the ``QUANTBOOK_UDF_MODULE`` env
var and imported once at startup (its import side-effects populate the registry).
"""

import importlib
import os
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
    """The worker loop. Returns 0 when the engine closes stdin (clean shutdown)."""
    _import_udf_module()
    while True:
        frame = _frame.read_frame(stdin)
        if frame is None:
            return 0  # engine closed stdin → clean exit
        ftype, payload = frame
        if ftype == _frame.HELLO:
            # Validate the HELLO shape; the engine decides version compatibility from
            # our ack. Reply with OUR protocol version + pid (pid → IDE debugpy, 6.4-3d).
            _codec.decode_hello(payload)
            _frame.write_frame(
                stdout, _frame.HELLO_ACK, _codec.encode_hello_ack(PROTOCOL_VERSION, os.getpid())
            )
        elif ftype == _frame.CALL:
            handle, call_id, args = _codec.decode_call(payload)
            try:
                fn = _registry.lookup(handle)
                if fn is None:
                    raise LookupError("no UDF registered for handle %d" % handle)
                result = _codec.as_grid(fn(args))
                _frame.write_frame(stdout, _frame.RETURN, _codec.encode_return(call_id, result))
            except Exception as e:  # noqa: BLE001 — ANY UDF failure becomes a RAISE, never crashes the loop
                _frame.write_frame(
                    stdout, _frame.RAISE, _codec.encode_raise(call_id, type(e).__name__, str(e))
                )
        elif ftype == _frame.CANCEL:
            # Cooperative cancel: v1 best-effort no-op. Hard cancel = the engine
            # SIGKILLs this process (the worker is designed to be killable mid-call).
            pass
        else:
            stderr.write("quantbook.worker: ignoring unexpected frame type %d\n" % ftype)
            stderr.flush()


def main():
    return run(sys.stdin.buffer, sys.stdout.buffer, sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
