#!/usr/bin/env python3
"""FE-1.5-1c-0 — the Python KERNEL CHILD of the out-of-process reactive transport.

FE-1.5-1.B proved `qb.publish(name, value, target)` + the kernel-memory registry + the
post_run_cell auto-republish + the v1 guards, IN-PROCESS (embedded IPython + a pyo3 Session
in ONE process, zero IPC). 1c-0 takes the SAME binding glue across a REAL process boundary:

  Node host (owns the napi WorkbookSession)  <-- republish frames (fd 3) --  THIS kernel child
           |                                                                       ^
           +----------------- execute frames (stdin) ----------------------------- +

This file is ONLY the kernel side. It runs the REAL 1.B binding glue (the registry, the
1b AST def/ref detector, the value fingerprint, the §13.3 DataFrame blank-fill) but holds
NO Session: where 1.B called `self._s.publish_dataset(...)`, this emits a `republish` frame
on a DEDICATED fd (fd 3). The host owns napi and does publishDataset + recalcDirty +
snapshotDelta (the cursor lives host-side). The detector is kernel-protocol-agnostic (plan
§11): it runs identically whether the cell executed in this embedded shell or a real ipykernel.

Channel separation (plan §11.4, No-Fallbacks): two planes, never multiplexed.
  - fd 1 (stdout): the CELL-OUTPUT plane. A cell that `print()`s writes here.
  - fd 3:          the CONTROL/REPUBLISH plane. NDJSON frames the host parses. A cell's
                   `print()` must NEVER corrupt this channel.
  - fd 2 (stderr): kernel diagnostics (inherited by the host).

Wire protocol (NDJSON, one object per line):
  host -> kernel (stdin):   {"type":"execute","code": "..."}
                            {"type":"close"}
  kernel -> host (fd 3):    {"type":"ready"}                         (startup handshake)
                            {"type":"republish","name","values","target"}   (0..N per cell)
                            {"type":"executed","ok":true}            (cell finished cleanly)
                            {"type":"error","error":"..."}           (cell raised / glue error)

`values` is the row-major, blank-filled value matrix (native python scalars, JSON `null`
for the blank-fill padding); `target` is the raw sheet-qualified A1 string ("Bench!A5:C5").
The kernel parses A1 ONLY for the fixed envelope dimensions (pure string math, no Session);
the host re-parses A1 to resolve the sheet id (it owns the Session). The kernel never sees
a sheet id -> the single-writer invariant (plan R8) holds: the host is the SOLE engine writer.

What 1c-0 carries vs DEFERS (explicit, No-Fallbacks = no silent narrowing):
  CARRIED (exercised across the boundary by reactive_kernel_host.mjs):
    - the registry + qb.publish (initial write frame) + the same-cell hook staying QUIET;
    - the 1b AST detector + value fingerprint (reassign / mutate-in-place / read-only-quiet);
    - the §13.3 DataFrame fixed-envelope blank-fill (the null padding must survive the wire);
    - G1 duplicate-name + G2 overlap guards (pure registry, no Session) -> a kernel-side
      PublishError propagates to the host as a FATAL `error` frame (transport fail-loud).
  DEFERRED to 1c-1 (needs transport this one-way republish plane does NOT yet have):
    - G3 formula-overwrite preflight: needs `session.cell()` -> a kernel->host->kernel
      state QUERY (a request/response round-trip; 1c-0's plane is one-way republish);
    - R7 undo/epoch force_check: needs a host->kernel `epoch_change` CONTROL message (the
      reverse direction). `force_check`/`on_epoch_change` are kept here (faithful to 1.B) but
      are NOT exercised in 1c-0 -- the host never drives an undo. Wired in 1c-1/1d.
"""

import ast
import json
import os
import sys


# fd 3 is the dedicated control/republish plane. It is opened by the host (spawn stdio
# index 3); writing to it here keeps republish frames OFF stdout (the cell-output plane).
_CTRL_FD = 3


def _emit(obj):
    """Write one NDJSON frame to the control plane (fd 3). os.write is unbuffered, so a
    republish is never stranded in a buffer behind a hung cell -- it reaches the host now.
    MED-3 (1c-0 Codex fold): os.write may do a PARTIAL write (return < len) for a large frame;
    a partial frame would corrupt the control stream / hang the host's readline waiting for the
    newline. Loop until every byte is written, and surface a closed pipe LOUDLY (No-Fallbacks)."""
    data = (json.dumps(obj) + "\n").encode("utf-8")
    view = memoryview(data)
    total = 0
    while total < len(data):
        try:
            n = os.write(_CTRL_FD, view[total:])
        except BrokenPipeError as exc:
            raise SystemExit(f"control plane (fd 3) closed mid-write: {exc!r}")
        if n == 0:
            raise SystemExit("control plane (fd 3) accepted 0 bytes (host closed it?)")
        total += n


# ---------------------------------------------------------------------------
# FE-1.5-1b change-detector (carried VERBATIM from reactive_kernel_publish_pyo3.py):
# cell source -> (defs, refs). Flat binds only; marimo ScopedVisitor is the scoping upgrade.
# ---------------------------------------------------------------------------
def _assign_target_names(target):
    """Names BOUND by an assignment target. Subscript/Attribute targets bind NO name
    (mutate-in-place of an existing object) -> deliberately excluded."""
    out = []
    if isinstance(target, ast.Name) and isinstance(target.ctx, ast.Store):
        out.append(target.id)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for e in target.elts:
            out.extend(_assign_target_names(e))
    elif isinstance(target, ast.Starred):
        out.extend(_assign_target_names(target.value))
    return out


def cell_defs_refs(code):
    """(defs, refs) for a cell: top-level bound names + all Load-context names."""
    tree = ast.parse(code)
    defs = set()
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign):
            for t in stmt.targets:
                defs.update(_assign_target_names(t))
        elif isinstance(stmt, ast.AugAssign):
            defs.update(_assign_target_names(stmt.target))
        elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
            defs.update(_assign_target_names(stmt.target))
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defs.add(stmt.name)
        elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
            for alias in stmt.names:
                defs.add((alias.asname or alias.name).split(".")[0])
    refs = {n.id for n in ast.walk(tree)
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    return defs, refs


# ---------------------------------------------------------------------------
# Value <-> grid: fingerprint (change-detect), matrix (serialize), blank-fill (§13.3 catch).
# Carried VERBATIM from reactive_kernel_publish_pyo3.py (Codex-audited there).
# ---------------------------------------------------------------------------
def _is_dataframe(v):
    return type(v).__module__.startswith("pandas") and type(v).__name__ == "DataFrame"


def _is_ndarray(v):
    return type(v).__module__.startswith("numpy") and type(v).__name__ == "ndarray"


def _fingerprint(v):
    """A hashable value fingerprint (replaces `==`; works for ndarray/DataFrame where `==` is
    elementwise). Changes iff the published value changes -- the auto-republish trigger."""
    if isinstance(v, bool):
        return ("bool", v)
    if isinstance(v, (int, float)):
        return ("num", v)
    if isinstance(v, str):
        return ("str", v)
    if _is_dataframe(v):
        import pandas as pd
        h = pd.util.hash_pandas_object(v, index=True).values.tobytes()
        return ("df", tuple(v.shape), tuple(str(c) for c in v.columns), h)
    if _is_ndarray(v):
        if v.dtype == object:
            raise PublishError(
                "object-dtype ndarray cannot be value-fingerprinted (tobytes hashes pointers); "
                "publish a numeric ndarray, or a list / DataFrame"
            )
        return ("ndarray", tuple(v.shape), str(v.dtype), v.tobytes())
    if isinstance(v, (list, tuple)):
        return ("seq", tuple(_fingerprint(e) for e in v))
    raise PublishError(f"unsupported published value type: {type(v)!r}")


def _to_matrix(v):
    """Published value -> row-major list-of-lists of NATIVE python scalars (json.dumps lossless;
    a stray numpy scalar raises in json.dumps -> fail-loud, no silent coercion)."""
    if isinstance(v, bool):
        return [[bool(v)]]
    if isinstance(v, (int, float, str)):
        return [[v]]
    if _is_dataframe(v):
        return v.to_numpy().tolist()
    if _is_ndarray(v):
        lst = v.tolist()
        if v.ndim == 1:
            return [list(lst)]
        if v.ndim == 2:
            return [list(row) for row in lst]
        raise PublishError(f"only 1-D/2-D ndarray publish; got ndim={v.ndim}")
    if isinstance(v, (list, tuple)):
        if v and isinstance(v[0], (list, tuple)):
            return [list(row) for row in v]
        return [[(bool(e) if isinstance(e, bool) else e) for e in v]]
    raise PublishError(f"unsupported published value type: {type(v)!r}")


def _blank_fill(matrix, env_rows, env_cols):
    """Pad to the FIXED ENVELOPE with None (-> JSON null -> Blank cell). §13.3 / Codex fix: a
    SHRUNK value would leave the engine's vacated cells holding STALE old values, so dependents
    would recompute against them. Publishing the FULL envelope every time prevents that."""
    nr = len(matrix)
    nc = len(matrix[0]) if matrix else 0
    for row in matrix:
        if len(row) != nc:
            raise PublishError(f"non-rectangular value matrix: row widths differ ({nc} vs {len(row)})")
    if nr > env_rows or nc > env_cols:
        raise PublishError(
            f"value {nr}x{nc} exceeds its fixed envelope {env_rows}x{env_cols} "
            f"(range-follows-cells is a v1 cut; publish to a larger target or re-register with replace=True)"
        )
    out = [[None] * env_cols for _ in range(env_rows)]
    for r in range(nr):
        for c in range(nc):
            out[r][c] = matrix[r][c]
    return out


# ---------------------------------------------------------------------------
# A1 target parsing -- kernel side parses ONLY for the envelope dimensions (no Session).
# ---------------------------------------------------------------------------
def _a1_cell(ref):
    """'B12' -> (row=11, col=1) 0-indexed. Loud reject on a malformed ref."""
    i = 0
    while i < len(ref) and ref[i].isalpha():
        i += 1
    letters, digits = ref[:i], ref[i:]
    if not letters or not digits or not digits.isdigit():
        raise PublishError(f"malformed A1 cell reference: {ref!r}")
    row1 = int(digits)
    if row1 < 1:
        raise PublishError(f"A1 row number must be >= 1: {ref!r}")
    col = 0
    for ch in letters.upper():
        col = col * 26 + (ord(ch) - ord("A") + 1)
    return row1 - 1, col - 1


def _parse_envelope(a1):
    """Sheet-qualified A1 ('Bench!A5:C5') -> (sheet_name, env_rows, env_cols, cell-set, range-dict).
    The kernel needs ONLY the envelope size (for blank-fill) + the cell-set (for the G2 overlap
    guard); the host re-parses A1 to resolve the sheet id. No Session is touched here."""
    sheet_name, sep, ref = a1.partition("!")
    if not sep:
        raise PublishError(f"target must be sheet-qualified, e.g. 'Bench!A1:C3'; got {a1!r}")
    if ":" in ref:
        a, b = ref.split(":", 1)
        r0, c0 = _a1_cell(a)
        r1, c1 = _a1_cell(b)
    else:
        r0, c0 = _a1_cell(ref)
        r1, c1 = r0, c0
    if r1 < r0 or c1 < c0:
        raise PublishError(f"target range end is before its start: {a1!r}")
    cells = {(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)}
    return sheet_name, (r1 - r0 + 1), (c1 - c0 + 1), cells, (sheet_name, r0, c0, r1, c1)


class PublishError(RuntimeError):
    """A loud, caller-facing binding rejection (No-Fallbacks: never swallow / default)."""


_SENTINEL = object()


class Quantbook:
    """The `qb` the notebook author calls, KERNEL-SIDE. Owns the name->target/fingerprint
    registry, serializes + blank-fills, and emits a `republish` frame on fd 3 for the host to
    apply. It is NOT the engine writer (the host is) -- it only SIGNALS (plan R8). No fallbacks:
    every failure raises and is re-surfaced to the host as a FATAL `error` frame."""

    def __init__(self, shell):
        self._shell = shell
        self._reg = {}            # name -> binding record
        self._hook_error = None

    # ---- the user-facing API ----------------------------------------------
    def publish(self, name, value, target, *, owner_cell_id=None, replace=False, overwrite=False):
        """Register name->target and emit the initial write frame. Fail-loud guards (§13.3):
          - G1 duplicate name (unless the SAME owner_cell re-runs, or replace=True);
          - G2 the envelope overlaps another published region;
          - replace may NOT move the target (range-follows-cells is a v1 cut).
        G3 (formula-overwrite) needs a host cell-state query -> DEFERRED to 1c-1. LOW-3 (1c-0
        Codex fold): `overwrite` is accepted for API compatibility with 1.B but is NOT threaded
        to the host and NOT enforced here (this kernel holds no Session). Until 1c-1 wires a
        host-side cell-state preflight, a target over a user formula WOULD be clobbered by the
        host's publishDataset -- a known, declared 1c-0 gap, not a silent fallback."""
        sheet_name, env_rows, env_cols, env_cells, _ = _parse_envelope(target)

        # GUARD 1 -- duplicate name.
        if name in self._reg:
            prev = self._reg[name]
            same_owner = owner_cell_id is not None and prev["owner_cell_id"] == owner_cell_id
            if not (replace or same_owner):
                raise PublishError(
                    f"name {name!r} is already published (owner {prev['owner_cell_id']!r}); "
                    f"re-run from the owning cell, or pass replace=True"
                )
            if (replace or same_owner) and prev["target"] != target:
                raise PublishError(
                    f"cannot move published {name!r} from {prev['target']!r} to {target!r} "
                    f"(range-follows-cells is a v1 cut)"
                )

        # GUARD 2 -- overlap with another published region's envelope.
        for other, rec in self._reg.items():
            if other == name:
                continue
            if rec["sheet"] == sheet_name and (env_cells & rec["cells"]):
                raise PublishError(
                    f"publish target for {name!r} overlaps the published region {other!r}"
                )

        # Fingerprint BEFORE any frame (validate-before-mutate; an unsupported/object-dtype value
        # rejects WITHOUT having emitted a partial write).
        fp = _fingerprint(value)
        self._reg[name] = {
            "target": target, "sheet": sheet_name, "cells": env_cells,
            "env_rows": env_rows, "env_cols": env_cols, "fp": fp,
            "owner_cell_id": owner_cell_id, "force_check": False, "stale": False,
        }
        self._write(name, value)

    def _write(self, name, value):
        """Where 1.B called session.publish_dataset, 1c emits a republish FRAME on fd 3. The host
        applies it: publishDataset + recalcDirty + snapshotDelta (cursor host-side)."""
        rec = self._reg[name]
        filled = _blank_fill(_to_matrix(value), rec["env_rows"], rec["env_cols"])
        _emit({"type": "republish", "name": name, "values": filled, "target": rec["target"]})

    # ---- epoch / undo (faithful to 1.B; NOT exercised in 1c-0) -------------
    def on_epoch_change(self):
        """1c-1 hook: the host signals this over a reverse control message when an undo/redo
        changes the grid out from under the registry. Marks every binding force_check so the
        NEXT touch republishes even if the python value is unchanged (plan R7). 1c-0 never
        drives an undo, so this is wired but unexercised (see module docstring)."""
        for rec in self._reg.values():
            rec["force_check"] = True

    # ---- the auto-republish hook (post_run_cell) --------------------------
    def on_post_run_cell(self, result):
        try:
            src = result.info.raw_cell if getattr(result, "info", None) is not None else ""
            defs, refs = cell_defs_refs(src)
            # MED-1 (1.B Codex fold): candidate set is exactly the AST-touched registered vars.
            # force_check only changes the DECISION for a touched var, not the candidate set.
            touched = (defs | refs) & set(self._reg)
            for name in sorted(touched):
                rec = self._reg[name]
                cur = self._shell.user_ns.get(name, _SENTINEL)
                if cur is _SENTINEL:
                    # MED-2 (1.B Codex fold): a touched-but-GONE var (`del x`) is marked stale +
                    # surfaced, never silently skipped. Full unpublish/clear is a v1 cut.
                    rec["stale"] = True
                    _emit({"type": "stale", "name": name})
                    continue
                fp = _fingerprint(cur)
                changed = fp != rec["fp"]
                if not changed and not rec["force_check"]:
                    continue
                self._write(name, cur)
                rec["fp"] = fp
                rec["force_check"] = False
                rec["stale"] = False
        except BaseException as exc:  # noqa: BLE001 -- re-raise so run_cell records it -> error frame
            self._hook_error = exc
            raise

    def take_hook_error(self):
        e, self._hook_error = self._hook_error, None
        return e


def main():
    # Embedded IPython shell -- the SAME InteractiveShell 1a/1b/1.B used. The detector is
    # protocol-agnostic, so this de-risks the TRANSPORT without the ZMQ/ipykernel weight (the
    # real ipykernel is 1c-0.5 / 1c-1, per plan §11.2-11.3).
    from IPython.core.interactiveshell import InteractiveShell
    shell = InteractiveShell.instance()
    qb = Quantbook(shell)
    shell.user_ns["qb"] = qb
    shell.events.register("post_run_cell", qb.on_post_run_cell)

    # Loud startup handshake (donor: qviz daemon-lifecycle) -- the host waits for this before
    # sending any execute, so a kernel that fails to import IPython fails LOUD (not a hang).
    _emit({"type": "ready"})

    # readline() in a loop, NOT `for line in sys.stdin` -- the latter read-ahead-buffers and can
    # deadlock a request/response protocol (it blocks for MORE input before yielding the first
    # line). The host spawns us with `python -u`, so stdin/stdout are unbuffered.
    while True:
        line = sys.stdin.readline()
        if line == "":          # EOF: the host closed stdin -> exit cleanly
            return
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit({"type": "error", "error": f"malformed execute frame: {exc}"})
            continue
        op = req.get("type")
        if op == "close":
            _emit({"type": "closed"})
            return
        if op != "execute":
            _emit({"type": "error", "error": f"unknown kernel op: {op!r}"})
            continue
        code = req["code"]
        # run_cell executes the body (an explicit qb.publish emits its frame) then fires the
        # post_run_cell hook (which may emit more frames). All frames precede the ack below.
        res = shell.run_cell(code, store_history=False)
        hook_err = qb.take_hook_error()
        if res.error_in_exec is not None:
            # The cell body raised (incl. a kernel-side PublishError from G1/G2). No-Fallbacks:
            # surface it to the host as a FATAL error frame, never a silent skipped republish.
            _emit({"type": "error", "error": f"cell raised: {res.error_in_exec!r}"})
        elif hook_err is not None:
            _emit({"type": "error", "error": f"post_run_cell hook error: {hook_err!r}"})
        else:
            _emit({"type": "executed", "ok": True})


if __name__ == "__main__":
    main()
