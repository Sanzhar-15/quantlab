"""Arrow ⇄ engine-value codec + CALL/RETURN/control payload codecs — the Python
mirror of `ql-udf/src/{codec,payload,control}.rs`. 3.9-compatible; needs `pyarrow`.

A UDF call's args and result are 2-D grids of spreadsheet values. A value is
encoded across five parallel Arrow columns discriminated by ``kind``:

    kind     populated column   engine Value
    blank    (none)             Blank
    number   num: float64       Number   (finite only; the Rust decoder rejects NaN/Inf)
    bool     bool: bool         Boolean
    text     str: utf8          Text
    error    err: utf8          Error (by sigil, e.g. "#DIV/0!")

The grid shape rides in the Arrow **schema metadata** (``rows``/``cols``) so
degenerate shapes round-trip. The Rust decoder validates the EXACT schema (field
names, types, nullability) before trusting positions, so this module MUST emit
that schema precisely: ``kind`` non-null utf8, then nullable ``num``/``str``/
``bool``/``err``.

Payload framings (the ``payload`` inside a `_frame` envelope):
    CALL    [u64 LE handle][u64 LE call_id][grid IPC bytes]
    RETURN  [u64 LE call_id][grid IPC bytes]
    RAISE   [u64 LE call_id][u32 LE exc_type_len][exc_type utf8][message utf8...]
    HELLO   [u32 LE protocol_version]
    HELLO_ACK [u32 LE protocol_version][u32 LE worker_pid]
"""

import math
import struct

import pyarrow as pa

from ._frame import MAX_FRAME_LEN

# Byte cap for an encoded RETURN grid — the Python mirror of the Rust
# `encode_grid_capped` byte guard (`MAX_GRID_BYTES = MAX_FRAME_LEN`). A RETURN frame is
# `[u32 total][u8 type][u64 call_id][grid IPC bytes]`, so the grid must leave room for
# the 1-byte type tag + 8-byte call_id and still fit `MAX_FRAME_LEN`. Capping the grid
# at this tighter budget makes the cap authoritative on the reply path (a clean
# `ValueError` → a RAISE) rather than deferring to the frame writer's own cap at write
# time (which, mid-reply, would force the worker to exit). Applied on the RETURN path
# ONLY — args are decoded, never encoded, by the worker.
_RETURN_HEADER_BYTES = 1 + 8  # frame type tag + u64 call_id
_MAX_RETURN_GRID_BYTES = MAX_FRAME_LEN - _RETURN_HEADER_BYTES


class Err:
    """A spreadsheet error value, identified by its sigil (e.g. ``"#DIV/0!"``)."""

    __slots__ = ("sigil",)

    def __init__(self, sigil):
        self.sigil = sigil

    def __repr__(self):
        return "Err(%r)" % (self.sigil,)

    def __eq__(self, other):
        return isinstance(other, Err) and other.sigil == self.sigil

    def __hash__(self):
        return hash(self.sigil)


class Grid:
    """A 2-D grid of cells in row-major order. A cell is one of: ``None`` (blank),
    ``float``/``int`` (number), ``bool`` (boolean), ``str`` (text), ``Err`` (error)."""

    __slots__ = ("rows", "cols", "cells")

    def __init__(self, rows, cols, cells):
        if len(cells) != rows * cols:
            raise ValueError("Grid: %d cells != rows*cols = %d*%d" % (len(cells), rows, cols))
        self.rows = rows
        self.cols = cols
        self.cells = cells

    def get(self, r, c):
        return self.cells[r * self.cols + c]

    @staticmethod
    def scalar(value):
        return Grid(1, 1, [value])

    def __eq__(self, other):
        return (
            isinstance(other, Grid)
            and other.rows == self.rows
            and other.cols == self.cols
            and other.cells == self.cells
        )

    def __repr__(self):
        return "Grid(%d, %d, %r)" % (self.rows, self.cols, self.cells)


def as_grid(value):
    """Coerce a UDF return value into a `Grid`: a `Grid` passes through; any scalar
    cell value becomes a 1x1 grid."""
    if isinstance(value, Grid):
        return value
    return Grid.scalar(value)


_GRID_SCHEMA_FIELDS = [
    pa.field("kind", pa.utf8(), nullable=False),
    pa.field("num", pa.float64(), nullable=True),
    pa.field("str", pa.utf8(), nullable=True),
    pa.field("bool", pa.bool_(), nullable=True),
    pa.field("err", pa.utf8(), nullable=True),
]


def encode_grid(grid):
    """Encode a `Grid` to Arrow IPC stream bytes (matching `ql-udf::codec::encode_grid`)."""
    kinds, nums, strs, bools, errs = [], [], [], [], []
    for cell in grid.cells:
        if cell is None:
            kinds.append("blank"); nums.append(None); strs.append(None); bools.append(None); errs.append(None)
        elif isinstance(cell, bool):
            # NB: bool is a subclass of int — check it BEFORE the numeric branch.
            kinds.append("bool"); nums.append(None); strs.append(None); bools.append(cell); errs.append(None)
        elif isinstance(cell, (int, float)):
            # The engine's Value::Number invariant is "always finite"; the Rust decoder REJECTS
            # NaN/Inf. Reject here at the source so a UDF returning a non-finite number (or a
            # huge int that overflows float() to inf) surfaces a comprehensible RAISE rather than
            # a cryptic codec error from the far side (6.4-3b audit-fix: python-encode-grid-
            # accepts-nan-inf-cryptic-engine-error).
            n = float(cell)
            if not math.isfinite(n):
                raise ValueError(
                    "UDF returned a non-finite number (%r); only finite numbers are supported" % cell
                )
            kinds.append("number"); nums.append(n); strs.append(None); bools.append(None); errs.append(None)
        elif isinstance(cell, str):
            kinds.append("text"); nums.append(None); strs.append(cell); bools.append(None); errs.append(None)
        elif isinstance(cell, Err):
            kinds.append("error"); nums.append(None); strs.append(None); bools.append(None); errs.append(cell.sigil)
        else:
            raise TypeError("Grid cell of unsupported type %r: %r" % (type(cell).__name__, cell))

    schema = pa.schema(
        _GRID_SCHEMA_FIELDS,
        metadata={"rows": str(grid.rows), "cols": str(grid.cols)},
    )
    batch = pa.RecordBatch.from_arrays(
        [
            pa.array(kinds, pa.utf8()),
            pa.array(nums, pa.float64()),
            pa.array(strs, pa.utf8()),
            pa.array(bools, pa.bool_()),
            pa.array(errs, pa.utf8()),
        ],
        schema=schema,
    )
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, schema) as writer:
        writer.write_batch(batch)
    return sink.getvalue().to_pybytes()


def _md_get(metadata, key):
    """Read a schema-metadata value; pyarrow returns keys/values as bytes."""
    if metadata is None:
        raise ValueError("grid schema has no metadata (missing rows/cols)")
    kb = key.encode("utf-8")
    if kb in metadata:
        return metadata[kb].decode("utf-8")
    if key in metadata:  # tolerate str-keyed metadata
        return metadata[key]
    raise ValueError("grid schema metadata missing %r" % key)


def decode_grid(data):
    """Decode Arrow IPC stream bytes (from the Rust engine) back to a `Grid`."""
    reader = pa.ipc.open_stream(pa.BufferReader(data))
    batches = list(reader)
    if not batches:
        raise ValueError("empty IPC stream (expected exactly one record batch)")
    if len(batches) != 1:
        raise ValueError("trailing data after the first record batch")
    batch = batches[0]
    # Guard the positional column access below: a grid batch with the wrong column count would
    # otherwise raise an opaque IndexError deep in the loop. The engine is the trusted producer
    # here, so a minimal count check (not the full Rust schema validation) suffices; once this is
    # reached from inside the worker's CALL try/except, the raise becomes a clean RAISE
    # (6.4-3b audit-fix: python-decode-grid-no-validation-positional-access).
    if batch.num_columns != 5:
        raise ValueError("grid batch has %d columns, expected 5 (kind,num,str,bool,err)" % batch.num_columns)
    schema = batch.schema
    rows = int(_md_get(schema.metadata, "rows"))
    cols = int(_md_get(schema.metadata, "cols"))

    kind = batch.column(0)
    num = batch.column(1)
    strc = batch.column(2)
    boolc = batch.column(3)
    errc = batch.column(4)

    cells = []
    for i in range(batch.num_rows):
        k = kind[i].as_py()
        if k == "blank":
            cells.append(None)
        elif k == "number":
            cells.append(num[i].as_py())
        elif k == "bool":
            cells.append(boolc[i].as_py())
        elif k == "text":
            cells.append(strc[i].as_py())
        elif k == "error":
            cells.append(Err(errc[i].as_py()))
        else:
            raise ValueError("unknown cell kind %r" % (k,))
    return Grid(rows, cols, cells)


# ---- CALL / RETURN payloads ----------------------------------------------

def decode_call(payload):
    """Decode a CALL payload → ``(handle, call_id, args_grid)``."""
    if len(payload) < 16:
        raise ValueError("CALL payload header truncated (need 16 bytes, got %d)" % len(payload))
    handle = struct.unpack("<Q", payload[0:8])[0]
    call_id = struct.unpack("<Q", payload[8:16])[0]
    args = decode_grid(payload[16:])
    return (handle, call_id, args)


def encode_return(call_id, result_grid):
    """Encode a RETURN payload: ``[u64 call_id][grid]``.

    Caps the encoded grid so the resulting RETURN frame fits ``MAX_FRAME_LEN`` (mirrors
    the Rust ``encode_grid_capped`` byte guard). A UDF returning a grid too large to
    transport raises a clear ``ValueError`` here — caught on the worker's reply-compute
    path and surfaced as a RAISE — instead of silently producing an unwritable frame.
    """
    grid = encode_grid(result_grid)
    if len(grid) > _MAX_RETURN_GRID_BYTES:
        raise ValueError(
            "UDF result grid too large: %d bytes > %d-byte cap"
            % (len(grid), _MAX_RETURN_GRID_BYTES)
        )
    return struct.pack("<Q", call_id) + grid


def encode_raise(call_id, exc_type, message):
    """Encode a RAISE payload: ``[u64 call_id][u32 exc_type_len][exc_type][message]``."""
    et = exc_type.encode("utf-8")
    return (
        struct.pack("<Q", call_id)
        + struct.pack("<I", len(et))
        + et
        + message.encode("utf-8")
    )


# ---- control payloads -----------------------------------------------------

def decode_hello(payload):
    """Decode a HELLO payload → the engine's protocol version."""
    if len(payload) < 4:
        raise ValueError("HELLO payload truncated")
    return struct.unpack("<I", payload[0:4])[0]


def encode_hello_ack(protocol_version, worker_pid):
    """Encode a HELLO_ACK payload: ``[u32 protocol_version][u32 worker_pid]``."""
    return struct.pack("<I", protocol_version) + struct.pack("<I", worker_pid)
