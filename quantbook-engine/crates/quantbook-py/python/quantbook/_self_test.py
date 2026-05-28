"""Standalone Python-side codec sanity check: ``python3 -m quantbook._self_test``.

Round-trips grids + the CALL/RETURN payload headers through the codec WITHOUT the
Rust engine — confirms the Python mirror is internally consistent (the Rust↔Python
cross-check is the `ql-udf` `process_smoke` integration test). Prints ``PASS`` and
exits 0 on success; raises (non-zero exit) on any mismatch.
"""

import struct
import sys

from . import _codec
from ._codec import Err, Grid


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def main():
    grids = [
        Grid(1, 1, [42.5]),
        Grid(1, 1, [True]),
        Grid(1, 1, [False]),
        Grid(1, 1, ["hello"]),
        Grid(1, 1, [""]),
        Grid(1, 1, [None]),
        Grid(1, 1, [Err("#DIV/0!")]),
        Grid(2, 3, [None, 1.0, True, "x", Err("#N/A"), -2.5]),
        Grid(3, 0, []),  # degenerate: rows>0, cols==0
        Grid(0, 0, []),  # fully empty
        Grid(0, 4, []),  # degenerate: rows==0, cols>0
    ]
    for g in grids:
        back = _codec.decode_grid(_codec.encode_grid(g))
        _check(back == g, "grid round-trip failed: %r != %r" % (back, g))

    # CALL payload: build [u64 handle][u64 call_id][grid] and decode it.
    g = Grid(1, 2, [10.0, "x"])
    call_bytes = struct.pack("<Q", 7) + struct.pack("<Q", 99) + _codec.encode_grid(g)
    handle, call_id, args = _codec.decode_call(call_bytes)
    _check(handle == 7 and call_id == 99, "decode_call header mismatch")
    _check(args == g, "decode_call args grid mismatch")

    # RETURN payload: [u64 call_id][grid] — verify the header + the grid tail decodes.
    ret = _codec.encode_return(99, g)
    _check(struct.unpack("<Q", ret[0:8])[0] == 99, "encode_return call_id mismatch")
    _check(_codec.decode_grid(ret[8:]) == g, "encode_return grid tail mismatch")

    # CALL truncated-header is loud, not an IndexError.
    try:
        _codec.decode_call(b"\x00" * 15)
        _check(False, "decode_call should reject a 15-byte payload")
    except ValueError:
        pass

    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
