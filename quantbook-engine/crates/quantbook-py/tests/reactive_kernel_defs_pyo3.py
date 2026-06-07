#!/usr/bin/env python3
"""FE-1.5-1b — Acid #1 GLUE: AST def/ref + value-fingerprint decides WHAT to republish.

FE-1.5-1a proved the seam (post_run_cell -> publish -> reactive recalc) but hard-coded a
scalar `==` value-diff over a single registered var. That does not generalize:
  - it must scan EVERY registered var every cell (O(registry) per run);
  - `cur == last` is ambiguous for ndarray/DataFrame (elementwise -> raises);
  - it cannot tell a reassignment from a mutate-in-place.

FE-1.5-1b builds the real change-detector the kernel hook will use:

  1. parse the just-run cell's SOURCE -> (defs, refs)
       defs = names the cell ASSIGNS at top level (incl. `+=`, multi-target, def/class/import)
       refs = names the cell READS (Load)
  2. a registered published var is a republish CANDIDATE iff it is in (defs | refs)
       -- the AST touch-set; we never fingerprint a var the cell did not mention.
  3. republish a candidate iff its VALUE FINGERPRINT changed since last publish.
       -- a fingerprint (hashable) replaces `==`: works for scalar/list (and, in the
          product, ndarray.tobytes()/DataFrame hash). This unifies reassignment AND
          mutate-in-place: `vec[1]=99` leaves `vec` a REF (not a def) but its fingerprint
          changes -> caught; `x = x` / `vec[0]=vec[0]` leave the fingerprint equal -> no-op.

Proof cells (fail-loud), driven through a REAL IPython post_run_cell hook:
  T1 x=7            -> def x, changed       -> republish x  -> C1=14
  T2 vec=[10,20,30] -> def vec, changed     -> republish vec-> D3=60
  T3 vec[1]=99      -> REF vec (mutate!)    -> republish vec-> D3=10+99+30=139   <-- the 1b case
  T4 x+=1           -> def x (AugAssign)    -> republish x  -> C1=16
  T5 y=x+1          -> ref x, unchanged     -> ENGINE-QUIET (no republish)
  T6 x=5; vec=[1,2,3] (one cell) -> def {x,vec} -> republish BOTH -> C1=10, D3=6
  T7 vec[0]=vec[0]  -> ref vec, fingerprint equal -> ENGINE-QUIET (mutate-to-same no-op)

In-process (embedded IPython + pyo3 Session), zero IPC -- the out-of-process kernel is 1c.
Run (Mac host, isolated venv): "$HOME/.fe15-spike-venv/bin/python" <thisfile>

KNOWN LIMITATIONS (deliberately out of scope for this spike; addressed when productizing):
  - ALIAS MUTATION is a false-negative. The candidate gate fingerprints only vars the cell
    names in (defs | refs). `y = vec; y[0] = 5` mutates the registered object without naming
    `vec` in the mutating statement, so `vec`'s changed fingerprint is never checked and the
    dependents do NOT recompute. The robust fix (object-identity tracking, or fingerprinting
    the whole registry when cheap, or explicit re-publish) is a productization decision, not a
    seam question -- so it is documented, not solved, here.
  - `cell_defs_refs` covers FLAT binds only: assign / augmented-assign / value-bearing
    annotated-assign / def / class / import. It does NOT add names bound by `for x in ...`,
    `with ... as x`, `except ... as x`, `match` captures, or walrus (`:=`). Those would be
    under-counted as defs (still caught as refs if read). The marimo `ScopedVisitor`
    (_ast/visitor.py) handles the full grammar + nested scoping and is the documented upgrade.
"""

import ast
import json
import shutil
import sys
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve()
_WORKSPACE_ROOT = _HERE.parents[3]  # crates/quantbook-py/tests -> root


def _resolve_cdylib() -> Path:
    import os
    env = os.environ.get("QL_PY_CDYLIB")
    if env:
        p = Path(env)
        if not p.exists():
            raise SystemExit(f"QL_PY_CDYLIB does not exist: {p}")
        return p
    ext = "dylib" if sys.platform == "darwin" else "so"
    candidates = [
        _WORKSPACE_ROOT / "target" / "release" / f"libquantbook_py.{ext}",
        _WORKSPACE_ROOT / "target" / "debug" / f"libquantbook_py.{ext}",
        _WORKSPACE_ROOT / "crates" / "quantbook-py" / "python" / "quantbook" / "_quantbook.abi3.so",
    ]
    for c in candidates:
        if c.exists():
            return c
    raise SystemExit(
        "no built quantbook-py extension found. Run `cargo build -p quantbook-py --release`.\n"
        "Looked in:\n  " + "\n  ".join(str(c) for c in candidates)
    )


def _load_quantbook():
    cdylib = _resolve_cdylib()
    print(f"[reactive-kernel-defs-pyo3] loading extension: {cdylib}", file=sys.stderr)
    staging = Path(tempfile.mkdtemp(prefix="qbpy_reactive_defs_"))
    target = staging / "_quantbook.so"
    shutil.copy2(cdylib, target)
    sys.path.insert(0, str(staging))
    import _quantbook  # noqa: E402
    return _quantbook


# ---------------------------------------------------------------------------
# The change-detector under test: cell source -> (defs, refs)
# ---------------------------------------------------------------------------
def _assign_target_names(target):
    """Names BOUND by an assignment target. Subscript/Attribute targets bind NO name
    (that is a mutate-in-place of an existing object) -> deliberately excluded."""
    out = []
    if isinstance(target, ast.Name) and isinstance(target.ctx, ast.Store):
        out.append(target.id)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for e in target.elts:
            out.extend(_assign_target_names(e))
    elif isinstance(target, ast.Starred):
        out.extend(_assign_target_names(target.value))
    # Subscript / Attribute -> no NAME bound (mutate-in-place) -> []
    return out


def cell_defs_refs(code):
    """(defs, refs) for a cell. defs = top-level bound names (assign/aug/ann/def/class/
    import); refs = all Load-context names. Top-level-only defs keep nested-function locals
    out of the def set; full marimo ScopedVisitor scoping is the documented FE-1.5-1b+ upgrade
    (this stdlib pass is exact for the flat reassignment/mutate cells acid #1 cares about)."""
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


def _fingerprint(v):
    """A hashable value fingerprint (replaces `==`). Scalars + 1-D sequences here; the
    product extends this to ndarray.tobytes() / a DataFrame content hash (same contract)."""
    if isinstance(v, bool):
        return ("bool", v)
    if isinstance(v, (int, float)):
        return ("num", v)
    if isinstance(v, (list, tuple)):
        return ("seq", tuple(_fingerprint(e) for e in v))
    raise SystemExit(f"[reactive-kernel-defs-pyo3] unsupported published value type: {type(v)!r}")


def _serialize(v):
    """Published value -> a row-major `{"values": [[...]]}` matrix. scalar -> 1x1; 1-D
    list -> a single 1xN row."""
    if isinstance(v, bool):
        return [[bool(v)]]
    if isinstance(v, (int, float)):
        return [[v]]
    if isinstance(v, (list, tuple)):
        return [[(bool(e) if isinstance(e, bool) else e) for e in v]]
    raise SystemExit(f"[reactive-kernel-defs-pyo3] unsupported published value type: {type(v)!r}")


_SENTINEL = object()


class DefAwareBridge:
    """The kernel-side glue: on post_run_cell, use (defs|refs) ∩ registry as the candidate
    set, then republish exactly the candidates whose fingerprint changed. No fallbacks: an
    engine error is recorded then re-raised; the driver re-raises after run_cell."""

    def __init__(self, session, shell, version):
        self._s = session
        self._shell = shell
        self._version = version
        self._published = {}   # name -> {"target": CellRange, "fp": last fingerprint}
        self.events = []
        self._error = None

    @property
    def version(self):
        return self._version

    def register(self, name, target, initial):
        self._published[name] = {"target": target, "fp": _fingerprint(initial)}

    def on_post_run_cell(self, result):
        try:
            version_before = self._version
            src = result.info.raw_cell if getattr(result, "info", None) is not None else ""
            defs, refs = cell_defs_refs(src)
            touched = (defs | refs) & set(self._published)
            republished = []
            considered = sorted(touched)  # deterministic order
            for name in considered:
                rec = self._published[name]
                cur = self._shell.user_ns.get(name, _SENTINEL)
                if cur is _SENTINEL:
                    continue
                fp = _fingerprint(cur)
                if fp == rec["fp"]:
                    continue  # touched but value-unchanged -> no republish (suppress no-op)
                self._s.publish_dataset(name, json.dumps({"values": _serialize(cur)}), rec["target"])
                rec["fp"] = fp
                republished.append(name)
            if not republished:
                self.events.append({"defs": sorted(defs), "refs_touched": sorted(touched),
                                    "republished": [], "delta_changed": [],
                                    "version_before": version_before, "version_after": self._version})
                return
            self._s.recalc_dirty()
            delta = self._s.snapshot_delta(self._version)
            self._version = delta["version"]
            self.events.append({"defs": sorted(defs), "refs_touched": sorted(touched),
                                "republished": republished, "delta_changed": delta["changedCells"],
                                "version_before": version_before, "version_after": self._version})
        except BaseException as exc:  # noqa: BLE001 -- record then re-raise loudly in driver
            self._error = exc
            raise

    def raise_if_errored(self):
        if self._error is not None:
            raise SystemExit(f"[reactive-kernel-defs-pyo3] glue error in hook: {self._error!r}")


def _find_cell(changed, row, col):
    for cc in changed:
        c = cc.get("cell")
        if c and c.get("row") == row and c.get("col") == col:
            return c
    return None


def _num(cell):
    v = cell.get("value") if cell else None
    return v.get("number") if v else None


def main():
    qb = _load_quantbook()
    s = qb.Session()
    sheet = s.add_sheet("Bench", 1000)

    # Scalar leg: x -> B1; dependent C1 = B1*2.
    B1 = {"sheet": sheet, "startRow": 0, "startCol": 1, "endRow": 0, "endCol": 1}
    C1 = (0, 2)
    s.set_formula(sheet, *C1, "B1*2")

    # Vector leg: vec[3] -> A3:C3 (row 2, cols 0..2); dependent D3 = A3+B3+C3.
    VEC_TGT = {"sheet": sheet, "startRow": 2, "startCol": 0, "endRow": 2, "endCol": 2}
    D3 = (2, 3)
    s.set_formula(sheet, *D3, "A3+B3+C3")

    # Seed both, capture the delta cursor.
    s.publish_dataset("x", json.dumps({"values": [[0]]}), B1)
    s.publish_dataset("vec", json.dumps({"values": [[0, 0, 0]]}), VEC_TGT)
    s.recalc_dirty()
    version = s.snapshot()["version"]

    from IPython.core.interactiveshell import InteractiveShell
    shell = InteractiveShell.instance()
    shell.user_ns["x"] = 0
    shell.user_ns["vec"] = [0, 0, 0]

    bridge = DefAwareBridge(s, shell, version)
    bridge.register("x", B1, initial=0)
    bridge.register("vec", VEC_TGT, initial=[0, 0, 0])
    shell.events.register("post_run_cell", bridge.on_post_run_cell)

    def run(code):
        bridge.events.clear()
        res = shell.run_cell(code, store_history=False)
        if res.error_in_exec is not None:
            raise SystemExit(f"[reactive-kernel-defs-pyo3] cell raised: {code!r} -> {res.error_in_exec!r}")
        bridge.raise_if_errored()
        return bridge.events[-1] if bridge.events else {"republished": [], "delta_changed": [],
                                                        "version_before": version, "version_after": version}

    def expect_republish(ev, names, label):
        if ev["republished"] != names:
            raise SystemExit(f"[reactive-kernel-defs-pyo3] {label} invalid: republished {ev['republished']} != {names}")
        if ev["version_after"] == ev["version_before"]:
            raise SystemExit(f"[reactive-kernel-defs-pyo3] {label} invalid: cursor did not advance on a republish")

    def expect_dep(ev, addr, value, label):
        got = _num(_find_cell(ev["delta_changed"], *addr))
        if got != value:
            raise SystemExit(f"[reactive-kernel-defs-pyo3] {label} invalid: dependent {addr} expected {value} in delta, got {got}")

    def expect_quiet(ev, label):
        # engine-quiet proven 3 ways: no republish + empty glue delta + independent probe.
        if ev["republished"] != []:
            raise SystemExit(f"[reactive-kernel-defs-pyo3] {label} invalid: unexpected republish {ev['republished']}")
        if ev["delta_changed"]:
            raise SystemExit(f"[reactive-kernel-defs-pyo3] {label} invalid: glue delta not empty: {ev['delta_changed']}")
        if ev["version_after"] != ev["version_before"]:
            raise SystemExit(f"[reactive-kernel-defs-pyo3] {label} invalid: cursor advanced with no republish")
        probe = s.snapshot_delta(bridge.version)
        if probe["changedCells"]:
            raise SystemExit(f"[reactive-kernel-defs-pyo3] {label} invalid: engine recomputed with no republish: {probe['changedCells']}")

    # T1: reassign scalar x -> def x, changed -> republish x only.
    ev = run("x = 7")
    expect_republish(ev, ["x"], "T1")
    expect_dep(ev, C1, 14, "T1")
    if _find_cell(ev["delta_changed"], *D3) is not None:
        raise SystemExit("[reactive-kernel-defs-pyo3] T1 invalid: vec dependent D3 must not recompute")

    # T2: reassign vector vec -> def vec, changed -> republish vec only.
    ev = run("vec = [10, 20, 30]")
    expect_republish(ev, ["vec"], "T2")
    expect_dep(ev, D3, 60, "T2")

    # T3: MUTATE-IN-PLACE vec[1]=99 -> vec is a REF (not a def) -> fingerprint changed -> republish.
    ev = run("vec[1] = 99")
    if ev["defs"] != []:
        raise SystemExit(f"[reactive-kernel-defs-pyo3] T3 invalid: vec[1]=99 must define NO name, got defs={ev['defs']}")
    expect_republish(ev, ["vec"], "T3")
    expect_dep(ev, D3, 10 + 99 + 30, "T3")

    # T4: augmented assign x += 1 -> def x (AugAssign) -> republish x. x was 7 -> 8 -> C1=16.
    ev = run("x += 1")
    if "x" not in ev["defs"]:
        raise SystemExit(f"[reactive-kernel-defs-pyo3] T4 invalid: x += 1 must define x, got defs={ev['defs']}")
    expect_republish(ev, ["x"], "T4")
    expect_dep(ev, C1, 16, "T4")

    # T5: read-only y = x + 1 -> x is a ref, unchanged -> engine-quiet.
    #     Assert x is a TOUCHED ref first, so this proves "touched, fingerprint equal,
    #     no republish" -- NOT the weaker "x was never seen" (which would also be quiet).
    ev = run("y = x + 1")
    if "x" not in ev["refs_touched"]:
        raise SystemExit(f"[reactive-kernel-defs-pyo3] T5 invalid: x must be a touched ref, got {ev['refs_touched']}")
    expect_quiet(ev, "T5")
    if shell.user_ns.get("y") != 9:
        raise SystemExit(f"[reactive-kernel-defs-pyo3] T5 invalid: y expected 9, got {shell.user_ns.get('y')}")

    # T6: multi-var single cell -> def {x, vec} -> republish BOTH.
    ev = run("x = 5\nvec = [1, 2, 3]")
    expect_republish(ev, ["vec", "x"], "T6")  # considered set is sorted -> ['vec','x']
    expect_dep(ev, C1, 10, "T6")
    expect_dep(ev, D3, 6, "T6")

    # T7: mutate-to-SAME-value vec[0]=vec[0] -> ref vec, fingerprint unchanged -> engine-quiet.
    ev = run("vec[0] = vec[0]")
    if "vec" not in ev["refs_touched"]:
        raise SystemExit(f"[reactive-kernel-defs-pyo3] T7 invalid: vec must be a touched ref, got {ev['refs_touched']}")
    expect_quiet(ev, "T7")

    # Final ground-truth straight from the engine.
    if _num(s.cell(sheet, *C1)) != 10:
        raise SystemExit(f"[reactive-kernel-defs-pyo3] invalid: final C1 expected 10, got {_num(s.cell(sheet, *C1))}")
    if _num(s.cell(sheet, *D3)) != 6:
        raise SystemExit(f"[reactive-kernel-defs-pyo3] invalid: final D3 expected 6, got {_num(s.cell(sheet, *D3))}")

    print("[reactive-kernel-defs-pyo3] PASS — AST defs/refs + fingerprint republishes exactly the changed published vars")
    print("  T1 x=7            -> republish x   -> C1=14 (vec untouched)")
    print("  T2 vec=[10,20,30] -> republish vec -> D3=60")
    print("  T3 vec[1]=99      -> republish vec  -> D3=139  (MUTATE-IN-PLACE via ref+fingerprint, defs empty)")
    print("  T4 x+=1           -> republish x   -> C1=16  (AugAssign def)")
    print("  T5 y=x+1          -> engine-quiet  (read-only)")
    print("  T6 x=5; vec=[1,2,3] -> republish x AND vec -> C1=10 D3=6")
    print("  T7 vec[0]=vec[0]  -> engine-quiet  (mutate-to-same, fingerprint equal)")


if __name__ == "__main__":
    main()
