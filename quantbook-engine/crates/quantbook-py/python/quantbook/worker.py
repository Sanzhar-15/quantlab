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

# --- RAISE size bounding -----------------------------------------------------------
# A UDF can raise an exception whose rendered text (type name + message) is enormous
# (a giant repr, a multi-hundred-MiB string). encode_raise + write_frame would then
# exceed `_frame.MAX_FRAME_LEN` (64 MiB) and raise `ValueError` *inside* the CALL
# handler — escaping `run()` and permanently killing the worker (TE4 BLOCKER:
# huge-exception-reply-write-kills-worker). Bound the rendered text comfortably under
# the cap so the UDF's error is still reported (truncated, clearly marked) and the
# worker survives. Budget = cap − frame tag (1) − RAISE header [u64 call_id][u32
# type_len] (12) − a comfortable 64 KiB margin.
_RAISE_HEADER_OVERHEAD = 1 + 8 + 4
_EXC_TEXT_BUDGET = _frame.MAX_FRAME_LEN - _RAISE_HEADER_OVERHEAD - 64 * 1024
_MAX_EXC_TYPE_BYTES = 4096  # type names are short; bound defensively anyway


def _truncate_utf8(text, max_bytes):
    """Return ``text`` if its UTF-8 encoding is ≤ ``max_bytes`` bytes, else a truncated
    copy (never splitting a multibyte char) with a clear marker noting the original
    size. The common case (a normal-sized message) returns ``text`` unchanged."""
    if max_bytes < 0:
        max_bytes = 0
    # errors="replace": a UDF exception message can carry lone surrogates (e.g. via
    # surrogateescape on undecodable bytes); a plain encode would raise UnicodeEncodeError
    # here, inside the CALL handler, and kill the worker. "replace" keeps it loud-but-safe;
    # the downstream decode(..., "ignore") round-trip is unaffected (TE4 lane-1 MED).
    encoded = text.encode("utf-8", "replace")
    if len(encoded) <= max_bytes:
        # Return the surrogate-SANITIZED form (identical to `text` for valid UTF-8; for a
        # lone-surrogate message this yields the U+FFFD-replaced text). This guarantees the
        # downstream encode_raise can strict-encode it -> a FAITHFUL RAISE, so the last-resort
        # minimal RAISE in run() stays truly-last-resort instead of firing on short surrogate
        # messages (TE4 audit: keep the No-Fallbacks loop-boundary fallback minimal).
        return encoded.decode("utf-8")
    marker = "...[truncated, original %d bytes]" % len(encoded)
    budget = max_bytes - len(marker.encode("utf-8"))
    if budget < 0:
        budget = 0
    # decode(errors="ignore") drops a trailing partial codepoint at the cut boundary.
    return encoded[:budget].decode("utf-8", "ignore") + marker


def _bounded_exc(exc):
    """Render ``exc`` to ``(type_name, message)`` bounded so the RAISE frame fits under
    `_frame.MAX_FRAME_LEN`. ``str(exc)`` is itself guarded: a UDF exception whose
    ``__str__`` misbehaves must STILL yield a reportable RAISE, never crash the loop."""
    exc_type = _truncate_utf8(type(exc).__name__, _MAX_EXC_TYPE_BYTES)
    try:
        raw_message = str(exc)
    except Exception as se:  # noqa: BLE001 — a misbehaving __str__ must not kill the loop
        raw_message = "<unprintable exception; str() raised %s>" % type(se).__name__
    msg_budget = _EXC_TEXT_BUDGET - len(exc_type.encode("utf-8"))
    return exc_type, _truncate_utf8(raw_message, msg_budget)


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
            try:
                frame = _frame.read_frame(stdin)
            except (EOFError, ValueError) as e:
                # A torn / zero-length / oversized INBOUND frame: the engine died mid-write
                # or the length-prefixed stream desynced. Such a stream cannot be resynced,
                # so the only safe action is to exit (the engine treats our exit as
                # worker-died and re-spawns). Surface loudly to stderr — never a silent
                # swallow (No-Fallbacks) — then exit nonzero to signal the abnormal cause.
                stderr.write(
                    "quantbook.worker: unrecoverable inbound frame error (%r); exiting\n" % (e,)
                )
                stderr.flush()
                return 1
            if frame is None:
                return 0  # engine closed stdin → clean exit
            ftype, payload = frame
            if ftype == _frame.HELLO:
                # Validate the HELLO shape; the engine decides version compatibility from our
                # ack. Reply with OUR protocol version + pid (pid → IDE debugpy, 6.4-3d).
                # Guarded: a malformed HELLO (decode error) or a non-BrokenPipe ACK-write
                # error must not escape run(). BrokenPipe = engine gone → outer shutdown;
                # anything else is unrecoverable here → log + exit so the engine respawns
                # (TE4 lane LOW: unguarded-HELLO-escapes-run).
                try:
                    _codec.decode_hello(payload)
                    _frame.write_frame(
                        stdout,
                        _frame.HELLO_ACK,
                        _codec.encode_hello_ack(PROTOCOL_VERSION, os.getpid()),
                    )
                except BrokenPipeError:
                    raise
                except Exception as he:  # noqa: BLE001
                    stderr.write("quantbook.worker: HELLO handshake failed (%r); exiting\n" % (he,))
                    stderr.flush()
                    return 1
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
                # === PHASE 1 — compute the reply (NON-ESCAPING) =======================
                # A RETURN on success, a RAISE on ANY error. Grid-decode + the UDF + the
                # capped RETURN-encode are all inside this try, so any failure (bad args
                # grid, missing handle, a raising UDF, an over-cap RETURN grid) becomes a
                # RAISE correlated to call_id — never a loop-killing crash. The RAISE-build
                # itself is ALSO guarded: a surrogate-laden message or a misbehaving
                # __str__ could make _bounded_exc / encode_raise raise, so a last-resort
                # minimal RAISE is emitted (and logged) rather than letting it escape run()
                # (TE4 lane-1/lane-2: RAISE-prep must not escape).
                try:
                    args = _codec.decode_grid(payload[16:])
                    fn = _registry.lookup(handle)
                    if fn is None:
                        raise LookupError("no UDF registered for handle %d" % handle)
                    result = _codec.as_grid(fn(args))
                    reply_type = _frame.RETURN
                    reply_payload = _codec.encode_return(call_id, result)
                except Exception as e:  # noqa: BLE001 — ANY UDF/arg/encode failure → RAISE
                    reply_type = _frame.RAISE
                    try:
                        exc_type, message = _bounded_exc(e)
                        reply_payload = _codec.encode_raise(call_id, exc_type, message)
                    except Exception as prep_err:  # noqa: BLE001 — last-resort loop boundary
                        try:
                            origin = type(e).__name__
                        except Exception:  # noqa: BLE001
                            origin = "?"
                        stderr.write(
                            "quantbook.worker: failed to render RAISE for call_id %d "
                            "(original=%s, error=%r); sending minimal RAISE\n"
                            % (call_id, origin, prep_err)
                        )
                        stderr.flush()
                        # Hard-coded ASCII, well under the cap → cannot itself raise.
                        reply_payload = _codec.encode_raise(
                            call_id, "Exception", "internal error rendering UDF exception"
                        )
                # === PHASE 2 — write the reply ========================================
                # BrokenPipe = engine gone → outer shutdown handler (clean exit 0). ANY
                # OTHER write error means the length-prefixed OUTPUT stream may be corrupt
                # mid-frame and CANNOT be resynced → exit so the engine respawns (NOT
                # continue). After Phase 1's cap, an over-cap RETURN is already a RAISE, so
                # a write-time error here is a genuine partial-write / OS failure (TE4
                # Codex: mid-frame-write-failure-must-exit-not-continue).
                try:
                    _frame.write_frame(stdout, reply_type, reply_payload)
                except BrokenPipeError:
                    raise
                except Exception as werr:  # noqa: BLE001
                    stderr.write(
                        "quantbook.worker: reply write failed for call_id %d (%r); output "
                        "stream may be corrupt mid-frame; exiting\n" % (call_id, werr)
                    )
                    stderr.flush()
                    return 1
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


def _usable_fd(stream):
    """Return ``stream``'s OS fd if it is a live, real fd, else ``None``.

    A host that gives the child no console (notably the engine embedded in
    node/electron — 6.4-3d Step 5) can leave ``sys.stdout``/``sys.stderr`` as
    ``None`` or backed by a closed fd. ``fileno()`` then raises or the attribute
    is missing; treat all of those as "no usable fd"."""
    if stream is None:
        return None
    try:
        return stream.fileno()
    except (OSError, ValueError, AttributeError):
        return None


def main():
    # Reserve the wire-protocol channel — the engine's pipe, which `ProcessWorker`
    # wires to the child's fd 1 (`Command::stdout(piped)`). Use the RAW fd 1, not
    # `sys.stdout.fileno()`: an embedded host may hand us a `None`/closed
    # sys.stdout, and the protocol channel is fd 1 regardless of the Python-level
    # stream object.
    proto_fd = os.dup(1)

    # Repoint fd 1 (and Python-level sys.stdout) at a "sink" so a stray UDF
    # `print()` / library stdout write / import-time chatter cannot corrupt the
    # frame stream (6.4-3b audit-fix: udf-print-corrupts-protocol-stdout). Prefer
    # the real stderr (fd 2) so such chatter stays visible; if stderr is unusable
    # (`sys.stderr is None` / closed — common when the host gives the child no
    # console), fall back to os.devnull so the redirect can NEVER crash the worker
    # on startup (6.4-3d Step 5 fix: worker-crashes-when-host-has-no-stderr —
    # the prior `os.dup2(sys.stderr.fileno(), 1)` raised `AttributeError` on
    # `None.fileno()`, the worker exited before HELLO_ACK, and every UDF call in
    # the IDE failed with `#CALC!`).
    diag = sys.stderr  # the worker's own diagnostic writer (may be None / broken)
    sink_fd = _usable_fd(diag)
    opened_devnull = False
    if sink_fd is None:
        sink_fd = os.open(os.devnull, os.O_WRONLY)
        opened_devnull = True
    os.dup2(sink_fd, 1)
    # NOTE (6.4-3d Step 5 audit): we deliberately do NOT `os.dup2(sink_fd, 2)`.
    # When the host left fd 2 closed (the very case that makes `sys.stderr` None),
    # the earlier `proto_fd = os.dup(1)` reuses fd 2 as the protocol channel — so
    # repointing fd 2 here would CLOBBER the protocol pipe and the worker would
    # exit before HELLO_ACK (verified: it breaks the node-hosted handshake). fd 2
    # is left as the host gave it; the worker never writes to a raw fd 2 (its
    # diagnostics go through the Python `diag` object, routed to the sink below).
    # Python-level sys.stdout → a fresh handle on the (redirected) fd 1.
    sys.stdout = os.fdopen(os.dup(1), "w", buffering=1)
    if opened_devnull:
        # stderr was unusable (None OR a broken non-None stream — 6.4-3d Step 5
        # audit-fix, Codex LOW): route the worker's own diagnostics to the sink
        # UNCONDITIONALLY, rather than leaving `diag` pointed at a broken stream
        # that would crash `run()` on `diag.write(...)`.
        diag = sys.stdout
        sys.stderr = sys.stdout

    proto = os.fdopen(proto_fd, "wb", buffering=0)
    try:
        return run(sys.stdin.buffer, proto, diag)
    finally:
        try:
            proto.close()
        except BrokenPipeError:
            pass  # engine already gone — nothing to flush
        if opened_devnull:
            try:
                os.close(sink_fd)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
