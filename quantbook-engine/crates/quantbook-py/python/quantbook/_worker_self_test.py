"""Worker-loop robustness self-test: ``python3 -m quantbook._worker_self_test``.

Drives :func:`quantbook.worker.run` in-process over in-memory streams (NO Rust engine,
NO subprocess) to prove the TE4 hardening. Unifying invariant: a single bad CALL must
NEVER kill the worker, EXCEPT when the OUTPUT stream is corrupted mid-frame (then exit
so the engine respawns). Checks:

  1. A UDF raising an exception whose message is far larger than ``_frame.MAX_FRAME_LEN``
     produces a (truncated) RAISE and does NOT kill the worker; a subsequent CALL still
     returns its result.
  2. :func:`quantbook._frame.write_frame` writes ALL bytes even when the underlying stream
     short-writes (the raw-pipe truncation/desync bug).
  3. (a) A UDF returning a grid larger than the frame cap yields an IMMEDIATE bounded
     RAISE (not a dropped reply); the worker survives.
  4. (b) A UDF raising a lone-surrogate message yields a RAISE; the worker survives.
  5. (c) A UDF raising an exception whose ``__str__`` itself raises yields a RAISE; the
     worker survives.
  6. (d) A mid-frame write failure (non-BrokenPipe ``OSError`` after a partial write) →
     ``run()`` returns 1 (EXIT, not continue).
  7. (e) A torn INBOUND frame → ``run()`` returns 1.

Mirrors the ``_self_test`` pattern: prints ``PASS`` and exits 0 on success; raises
(non-zero exit) on any mismatch. The checks are exposed via :func:`run_checks` so the
canonical ``python -m quantbook._self_test`` entrypoint can exercise them too.
"""

import io
import struct
import sys

import quantbook

from . import _codec, _frame, worker

# Distinct handles so this test never collides with the `_smoke_udfs` fixtures.
_H_HUGE = 90001
_H_ECHO = 90002
_H_RET_HUGE = 90003
_H_SURR = 90004
_H_BADSTR = 90005


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def _all_frames(stream):
    """Read every frame from ``stream`` until clean EOF; returns ``[(ftype, payload), ...]``."""
    out = []
    while True:
        f = _frame.read_frame(stream)
        if f is None:
            return out
        out.append(f)


def _call_payload(handle, call_id, grid):
    return struct.pack("<Q", handle) + struct.pack("<Q", call_id) + _codec.encode_grid(grid)


def _parse_raise(payload):
    call_id = struct.unpack("<Q", payload[0:8])[0]
    type_len = struct.unpack("<I", payload[8:12])[0]
    exc_type = payload[12 : 12 + type_len].decode("utf-8")
    message = payload[12 + type_len :].decode("utf-8")
    return call_id, exc_type, message


def _parse_return(payload):
    call_id = struct.unpack("<Q", payload[0:8])[0]
    grid = _codec.decode_grid(payload[8:])
    return call_id, grid


def _raise_huge(args):
    # 70 MiB message > MAX_FRAME_LEN (64 MiB): the RAISE frame would overflow the cap
    # unless the worker bounds the rendered exception text.
    raise ValueError("E" * (70 * 1024 * 1024))


def _echo(args):
    return args


def _test_huge_exception_does_not_kill_worker():
    quantbook.register_formula_function(_raise_huge, handle=_H_HUGE, replace=True)
    quantbook.register_formula_function(_echo, handle=_H_ECHO, replace=True)

    # Inbound stream: HELLO, CALL(huge-raise, id=1), CALL(echo, id=2), then EOF.
    stdin = io.BytesIO()
    _frame.write_frame(stdin, _frame.HELLO, struct.pack("<I", worker.PROTOCOL_VERSION))
    echo_in = _codec.Grid(1, 2, [3.0, "x"])
    _frame.write_frame(stdin, _frame.CALL, _call_payload(_H_HUGE, 1, _codec.Grid.scalar(0.0)))
    _frame.write_frame(stdin, _frame.CALL, _call_payload(_H_ECHO, 2, echo_in))
    stdin.seek(0)

    stdout = io.BytesIO()
    stderr = io.StringIO()
    rc = worker.run(stdin, stdout, stderr)
    _check(rc == 0, "worker.run should exit 0 on clean stdin EOF, got %r" % (rc,))

    stdout.seek(0)
    f1 = _frame.read_frame(stdout)
    _check(
        f1 is not None and f1[0] == _frame.HELLO_ACK,
        "expected HELLO_ACK first, got %r" % (f1,),
    )
    f2 = _frame.read_frame(stdout)
    _check(
        f2 is not None and f2[0] == _frame.RAISE,
        "expected a (bounded) RAISE for the huge exception, got %r" % (f2,),
    )
    cid, exc_type, message = _parse_raise(f2[1])
    _check(cid == 1, "RAISE call_id mismatch: %r" % (cid,))
    _check(exc_type == "ValueError", "RAISE exc_type mismatch: %r" % (exc_type,))
    msg_bytes = len(message.encode("utf-8"))
    _check(
        msg_bytes < _frame.MAX_FRAME_LEN,
        "RAISE message not bounded under MAX_FRAME_LEN (%d bytes)" % msg_bytes,
    )
    _check("truncated" in message, "expected a truncation marker in the bounded message")

    f3 = _frame.read_frame(stdout)
    _check(
        f3 is not None and f3[0] == _frame.RETURN,
        "worker died after the huge exception: expected a RETURN for the 2nd CALL, got %r" % (f3,),
    )
    cid2, grid = _parse_return(f3[1])
    _check(
        cid2 == 2 and grid == echo_in,
        "2nd CALL RETURN mismatch after recovery: id=%r grid=%r" % (cid2, grid),
    )
    _check(_frame.read_frame(stdout) is None, "unexpected trailing frame after the 2nd RETURN")


class _ShortWriter:
    """A binary sink whose ``write()`` accepts at most ``chunk`` bytes per call, simulating
    a pipe that short-writes — proving ``write_frame`` loops until every byte lands."""

    def __init__(self, chunk):
        self.chunk = chunk
        self.buf = bytearray()
        self.calls = 0

    def write(self, data):
        self.calls += 1
        b = bytes(data[: self.chunk])
        self.buf.extend(b)
        return len(b)

    def flush(self):
        pass


def _test_write_frame_handles_short_writes():
    payload = bytes(range(256)) * 4096  # 1 MiB of varied bytes
    sw = _ShortWriter(chunk=4096)
    _frame.write_frame(sw, _frame.RETURN, payload)
    _check(sw.calls > 1, "short-writer should have taken many writes (got %d)" % sw.calls)
    # The bytes on the wire must be the complete, correctly framed message.
    back = _frame.read_frame(io.BytesIO(bytes(sw.buf)))
    _check(back is not None, "short-written frame did not round-trip (got None)")
    _check(back[0] == _frame.RETURN, "short-written frame type mismatch: %r" % (back[0],))
    _check(
        back[1] == payload,
        "short-written payload truncated/corrupted (%d of %d bytes)"
        % (len(back[1]), len(payload)),
    )


def _return_huge_grid(args):
    # 65 MiB single-cell string → the encoded grid exceeds the RETURN frame cap.
    return _codec.Grid.scalar("A" * (65 * 1024 * 1024))


def _raise_surrogate(args):
    # A lone surrogate (the shape produced by surrogateescape on undecodable bytes) —
    # `.encode("utf-8")` of this would raise UnicodeEncodeError.
    raise ValueError("\udc80bad")


class _BadStr(Exception):
    def __str__(self):
        raise RuntimeError("boom in __str__")


def _raise_bad_str(args):
    raise _BadStr()


def _drive_two_calls(udf_handle):
    """Run a session: HELLO, CALL(udf_handle, id=1), CALL(echo, id=2), EOF. Returns the
    list of stdout frames. The 1st CALL is expected to fail (→ RAISE); the 2nd proves the
    worker survived and still serves CALLs."""
    quantbook.register_formula_function(_echo, handle=_H_ECHO, replace=True)
    stdin = io.BytesIO()
    _frame.write_frame(stdin, _frame.HELLO, struct.pack("<I", worker.PROTOCOL_VERSION))
    echo_in = _codec.Grid.scalar(7.0)
    _frame.write_frame(stdin, _frame.CALL, _call_payload(udf_handle, 1, _codec.Grid.scalar(0.0)))
    _frame.write_frame(stdin, _frame.CALL, _call_payload(_H_ECHO, 2, echo_in))
    stdin.seek(0)
    stdout = io.BytesIO()
    stderr = io.StringIO()
    rc = worker.run(stdin, stdout, stderr)
    _check(rc == 0, "worker.run should exit 0 on clean stdin EOF, got %r" % (rc,))
    stdout.seek(0)
    frames = _all_frames(stdout)
    _check(
        len(frames) == 3 and frames[0][0] == _frame.HELLO_ACK,
        "expected HELLO_ACK + RAISE + RETURN, got %r" % ([f[0] for f in frames],),
    )
    cid2, grid = _parse_return(frames[2][1])
    _check(
        frames[2][0] == _frame.RETURN and cid2 == 2 and grid == echo_in,
        "worker did not survive: 2nd CALL reply was %r (id=%r)" % (frames[2][0], cid2),
    )
    return frames


def _test_huge_return_grid_yields_raise_and_survives():
    """(a) A UDF returning a grid larger than MAX_FRAME_LEN yields an IMMEDIATE bounded
    RAISE for that call_id (not a dropped reply / engine timeout), and the worker serves
    the next CALL."""
    quantbook.register_formula_function(_return_huge_grid, handle=_H_RET_HUGE, replace=True)
    frames = _drive_two_calls(_H_RET_HUGE)
    _check(frames[1][0] == _frame.RAISE, "huge RETURN should yield a RAISE, got %r" % (frames[1][0],))
    cid, exc_type, message = _parse_raise(frames[1][1])
    _check(cid == 1 and exc_type == "ValueError", "huge-RETURN RAISE header: %r/%r" % (cid, exc_type))
    _check("too large" in message, "expected the grid-too-large message, got %r" % (message,))


def _test_surrogate_message_survives():
    """(b) A UDF raising an exception with a lone-surrogate message yields a RAISE and the
    worker survives + serves the next CALL."""
    quantbook.register_formula_function(_raise_surrogate, handle=_H_SURR, replace=True)
    frames = _drive_two_calls(_H_SURR)
    _check(frames[1][0] == _frame.RAISE, "surrogate message should yield a RAISE, got %r" % (frames[1][0],))
    cid, _exc_type, _message = _parse_raise(frames[1][1])
    _check(cid == 1, "surrogate RAISE call_id mismatch: %r" % (cid,))


def _test_str_raises_survives():
    """(c) A UDF raising an exception whose __str__ itself raises still yields a RAISE; the
    worker survives."""
    quantbook.register_formula_function(_raise_bad_str, handle=_H_BADSTR, replace=True)
    frames = _drive_two_calls(_H_BADSTR)
    _check(frames[1][0] == _frame.RAISE, "__str__-raising exc should yield a RAISE, got %r" % (frames[1][0],))
    cid, exc_type, message = _parse_raise(frames[1][1])
    _check(cid == 1, "__str__-raise RAISE call_id mismatch: %r" % (cid,))
    _check(
        exc_type == "_BadStr" and "unprintable" in message,
        "expected the guarded-__str__ RAISE, got %r/%r" % (exc_type, message),
    )


class _FailingWriter:
    """A binary sink whose ``write()`` succeeds until ``fail_after`` total bytes, then raises a
    non-BrokenPipe ``OSError`` mid-frame — simulating a partial-write / corrupt output stream."""

    def __init__(self, fail_after):
        self.fail_after = fail_after
        self.written = 0
        self.buf = bytearray()

    def write(self, data):
        if self.written >= self.fail_after:
            raise OSError("simulated mid-frame write failure")
        b = bytes(data)
        self.buf.extend(b)
        self.written += len(b)
        return len(b)

    def flush(self):
        pass


def _test_midwrite_failure_exits():
    """(d) A stdout whose write() raises a non-BrokenPipe OSError after a partial write of a
    reply → run() returns 1 (EXIT, not continue): a length-prefixed stream cannot be
    resynced once a frame is half-written."""
    quantbook.register_formula_function(_echo, handle=_H_ECHO, replace=True)
    stdin = io.BytesIO()
    _frame.write_frame(stdin, _frame.HELLO, struct.pack("<I", worker.PROTOCOL_VERSION))
    _frame.write_frame(stdin, _frame.CALL, _call_payload(_H_ECHO, 1, _codec.Grid.scalar(1.0)))
    stdin.seek(0)
    # The HELLO_ACK frame is 13 bytes; fail 2 bytes into the CALL reply (a partial write).
    stdout = _FailingWriter(fail_after=15)
    stderr = io.StringIO()
    rc = worker.run(stdin, stdout, stderr)
    _check(rc == 1, "a non-BrokenPipe mid-frame write failure must EXIT with 1, got %r" % (rc,))
    _check("corrupt" in stderr.getvalue(), "expected a mid-frame-corruption log on stderr")


def _test_torn_inbound_frame_exits():
    """(e) A torn INBOUND frame (length prefix promises more bytes than arrive) → run()
    returns 1."""
    stdin = io.BytesIO()
    stdin.write(struct.pack("<I", 100))  # claim a 100-byte body...
    stdin.write(b"\x03" + b"\x00" * 9)  # ...but supply only 10 bytes, then EOF (torn)
    stdin.seek(0)
    rc = worker.run(stdin, io.BytesIO(), io.StringIO())
    _check(rc == 1, "a torn inbound frame must EXIT with 1, got %r" % (rc,))


def run_checks():
    _test_huge_exception_does_not_kill_worker()
    _test_write_frame_handles_short_writes()
    _test_huge_return_grid_yields_raise_and_survives()
    _test_surrogate_message_survives()
    _test_str_raises_survives()
    _test_midwrite_failure_exits()
    _test_torn_inbound_frame_exits()


def main():
    run_checks()
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
