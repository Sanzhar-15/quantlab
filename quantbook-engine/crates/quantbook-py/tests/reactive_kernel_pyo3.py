#!/usr/bin/env python3
"""FE-1.5-1a — Acid #1 SEAM spike: a REAL IPython cell execution drives reactive recalc.

FE-1.5-0 proved the engine path `publish_dataset -> recalc_dirty -> snapshot_delta`
reactively recomputes dependents, but it called publish_dataset DIRECTLY. This spike
proves the kernel-side GLUE -- the actual FE-1.5-1 risk:

    user runs a cell:  x = 7
      -> IPython `post_run_cell` hook fires
      -> hook detects the PUBLISHED var `x` changed in shell.user_ns
      -> hook serializes + publish_dataset(B1) + recalc_dirty + snapshot_delta
      -> the DEPENDENT formula cells (C1=B1*2, D1=B1+100) reactively recompute

No user action beyond running the cell. Everything is IN ONE PROCESS (embedded
IPython + the pyo3 Session) -- the lower bound + the seam proof, zero IPC. The
out-of-process kernel + Node-host topology is FE-1.5-1c.

PROOF (fail-loud, mirrors the FE-1.5-0 harness):
  + reassigning a published var recomputes ALL its dependents (fan-out C1 AND D1);
  + a cell that does NOT reassign the var (reads it, or assigns something else)
    triggers NO republish and NO dependent recompute.

Run (Mac host, isolated venv with IPython + python3.12):
    VENV=$HOME/.fe15-spike-venv
    "$VENV/bin/python" crates/quantbook-py/tests/reactive_kernel_pyo3.py
Override the cdylib with QL_PY_CDYLIB=/abs/path/to/libquantbook_py.{dylib,so}.
"""

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
    print(f"[reactive-kernel-pyo3] loading extension: {cdylib}", file=sys.stderr)
    staging = Path(tempfile.mkdtemp(prefix="qbpy_reactive_kernel_"))
    target = staging / "_quantbook.so"
    shutil.copy2(cdylib, target)
    sys.path.insert(0, str(staging))
    import _quantbook  # noqa: E402
    return _quantbook


def _find_cell(changed, row, col):
    """changedCells entries are {"cell": {"row","col","value"}} -> the dependent cell or None."""
    for cc in changed:
        c = cc.get("cell")
        if c and c.get("row") == row and c.get("col") == col:
            return c
    return None


def _num(cell):
    v = cell.get("value") if cell else None
    return v.get("number") if v else None


_SENTINEL = object()


class ReactiveBridge:
    """The kernel-side glue under test: a post_run_cell hook that republishes any
    registered Python var whose value changed, then reactively recalcs dependents.

    This is the in-process stand-in for FE-1.5-1c's kernel->host->engine path. It
    deliberately mirrors the host's responsibility: detect change, serialize,
    publish_dataset + recalc_dirty + snapshot_delta, thread the version token.
    No fallbacks: any engine error propagates (recorded + re-raised by the driver).
    """

    def __init__(self, session, shell, version):
        self._s = session
        self._shell = shell
        self._version = version
        # name -> {"target": CellRange dict, "last": last published value}
        self._published = {}
        # per-cell record the driver asserts against: list of dicts
        self.events = []
        self._error = None

    @property
    def version(self):
        """The current delta cursor (advances only on a real publish→recalc→delta)."""
        return self._version

    def register(self, name, target, initial):
        self._published[name] = {"target": target, "last": initial}

    def _serialize_scalar(self, v):
        # v1 spike: scalars only (int/float/bool). Frames/arrays are FE-1.5-1b.
        if isinstance(v, bool):
            return [[bool(v)]]
        if isinstance(v, (int, float)):
            return [[v]]
        raise SystemExit(f"[reactive-kernel-pyo3] unsupported published value type: {type(v)!r}")

    def on_post_run_cell(self, result):
        # Fail-loud: capture any glue error so the driver exits non-zero. We do NOT
        # swallow it into a default -- we re-raise from the driver after run_cell.
        try:
            version_before = self._version
            republished = []
            for name, rec in self._published.items():
                cur = self._shell.user_ns.get(name, _SENTINEL)
                if cur is _SENTINEL:
                    continue  # var deleted/never bound this run; out of scope for the spike
                if cur == rec["last"]:
                    continue  # unchanged -> NO republish (the negative-control path)
                matrix = self._serialize_scalar(cur)
                self._s.publish_dataset(name, json.dumps({"values": matrix}), rec["target"])
                rec["last"] = cur
                republished.append(name)
            if not republished:
                # NO republish -> the cursor MUST NOT advance (negative-control invariant).
                self.events.append({"republished": [], "delta_changed": [],
                                    "version_before": version_before, "version_after": self._version})
                return
            self._s.recalc_dirty()
            delta = self._s.snapshot_delta(self._version)
            self._version = delta["version"]
            self.events.append({
                "republished": republished,
                "delta_changed": delta["changedCells"],
                "version_before": version_before,
                "version_after": self._version,
            })
        except BaseException as exc:  # noqa: BLE001 -- record then re-raise loudly in driver
            self._error = exc
            raise

    def raise_if_errored(self):
        if self._error is not None:
            raise SystemExit(f"[reactive-kernel-pyo3] glue error in hook: {self._error!r}")


def main():
    qb = _load_quantbook()
    s = qb.Session()
    sheet = s.add_sheet("Bench", 1000)

    # Dependents that publish_dataset never writes -- the reactive proof targets.
    #   C1 = B1*2     (row 0, col 2)   fan-out leg 1
    #   D1 = B1+100   (row 0, col 3)   fan-out leg 2
    #   E1 = 5        (row 0, col 4)   CONSTANT control: must never recompute on a republish
    B1 = {"sheet": sheet, "startRow": 0, "startCol": 1, "endRow": 0, "endCol": 1}
    C1, D1, E1 = (0, 2), (0, 3), (0, 4)
    s.set_formula(sheet, *C1, "B1*2")
    s.set_formula(sheet, *D1, "B1+100")
    s.set_formula(sheet, *E1, "5")

    # Seed: publish x=0 once, recalc, capture the delta cursor.
    s.publish_dataset("x", json.dumps({"values": [[0]]}), B1)
    s.recalc_dirty()
    version = s.snapshot()["version"]

    # --- Build the embedded IPython shell + register the reactive hook ---
    from IPython.core.interactiveshell import InteractiveShell
    shell = InteractiveShell.instance()
    shell.user_ns["x"] = 0  # mirror the seeded publish so the first reassign is a real change

    bridge = ReactiveBridge(s, shell, version)
    bridge.register("x", B1, initial=0)
    shell.events.register("post_run_cell", bridge.on_post_run_cell)

    def run(code):
        bridge.events.clear()
        res = shell.run_cell(code, store_history=False)
        if res.error_in_exec is not None:
            raise SystemExit(f"[reactive-kernel-pyo3] cell raised: {code!r} -> {res.error_in_exec!r}")
        bridge.raise_if_errored()
        return bridge.events[-1] if bridge.events else {"republished": [], "delta_changed": []}

    def assert_token_advanced(ev, label):
        # A positive publish MUST advance the delta cursor; otherwise a broken
        # snapshot_delta that re-serves changed cells against a stale token would let
        # the positive tests pass without a real recompute step.
        if ev["version_after"] == ev["version_before"]:
            raise SystemExit(f"[reactive-kernel-pyo3] {label} invalid: delta cursor did not advance on a republish")

    def assert_engine_quiet(ev, label):
        # The negative-control invariant, proven THREE independent ways:
        #  (1) the glue did not republish;
        #  (2) the glue's recorded delta is empty;
        #  (3) an INDEPENDENT snapshot_delta against the current cursor returns no
        #      changed cells -- i.e. the ENGINE itself recomputed nothing (not just
        #      that the hook chose not to look). This closes the "tautologically
        #      empty" gap Codex flagged.
        if ev["republished"] != []:
            raise SystemExit(f"[reactive-kernel-pyo3] {label} invalid: unexpected republish {ev['republished']}")
        if ev["delta_changed"]:
            raise SystemExit(f"[reactive-kernel-pyo3] {label} invalid: glue delta not empty: {ev['delta_changed']}")
        if ev["version_after"] != ev["version_before"]:
            raise SystemExit(f"[reactive-kernel-pyo3] {label} invalid: cursor advanced with no republish")
        probe = s.snapshot_delta(bridge.version)
        if probe["changedCells"]:
            raise SystemExit(f"[reactive-kernel-pyo3] {label} invalid: engine recomputed cells with no republish: {probe['changedCells']}")

    # ---- T1: reassign the published var -> ALL dependents reactively recompute ----
    ev = run("x = 7")
    if ev["republished"] != ["x"]:
        raise SystemExit(f"[reactive-kernel-pyo3] T1 invalid: expected republish [x], got {ev['republished']}")
    assert_token_advanced(ev, "T1")
    c1 = _find_cell(ev["delta_changed"], *C1)
    d1 = _find_cell(ev["delta_changed"], *D1)
    if _num(c1) != 14:
        raise SystemExit(f"[reactive-kernel-pyo3] T1 invalid: C1 (=B1*2) expected 14 in delta, got {_num(c1)} (cell={c1})")
    if _num(d1) != 107:
        raise SystemExit(f"[reactive-kernel-pyo3] T1 invalid: D1 (=B1+100) expected 107 in delta, got {_num(d1)} (cell={d1})")
    if _find_cell(ev["delta_changed"], *E1) is not None:
        raise SystemExit("[reactive-kernel-pyo3] T1 invalid: constant E1 must NOT recompute on a republish")

    # ---- T2: a cell that READS x but does not reassign it -> NO republish, NO recompute ----
    ev = run("z = x + 1")
    assert_engine_quiet(ev, "T2")
    if shell.user_ns.get("z") != 8:
        raise SystemExit(f"[reactive-kernel-pyo3] T2 invalid: z expected 8, got {shell.user_ns.get('z')}")

    # ---- T3: assign a DIFFERENT var -> NO republish of x ----
    ev = run("y = 99")
    assert_engine_quiet(ev, "T3")

    # ---- T4: reassign x again to a NEW value -> dependents recompute to the new value ----
    ev = run("x = 8")
    if ev["republished"] != ["x"]:
        raise SystemExit(f"[reactive-kernel-pyo3] T4 invalid: expected republish [x], got {ev['republished']}")
    assert_token_advanced(ev, "T4")
    if _num(_find_cell(ev["delta_changed"], *C1)) != 16:
        raise SystemExit(f"[reactive-kernel-pyo3] T4 invalid: C1 expected 16, got {_num(_find_cell(ev['delta_changed'], *C1))}")
    if _num(_find_cell(ev["delta_changed"], *D1)) != 108:
        raise SystemExit(f"[reactive-kernel-pyo3] T4 invalid: D1 expected 108, got {_num(_find_cell(ev['delta_changed'], *D1))}")

    # ---- T5: reassign x to the SAME value -> value-diff suppresses the republish ----
    #         (now proven engine-quiet the same independent way as T2/T3) ----
    ev = run("x = 8")
    assert_engine_quiet(ev, "T5")

    # Final ground-truth read straight from the engine (not via delta).
    if _num(s.cell(sheet, *C1)) != 16 or _num(s.cell(sheet, *D1)) != 108:
        raise SystemExit("[reactive-kernel-pyo3] invalid: final engine state C1/D1 != 16/108")

    print("[reactive-kernel-pyo3] PASS — post_run_cell hook reactively recomputes dependents")
    print("  T1 x=7  -> C1=14 D1=107 (fan-out), E1 constant untouched")
    print("  T2 z=x+1-> no republish (read-only)")
    print("  T3 y=99 -> no republish (unrelated var)")
    print("  T4 x=8  -> C1=16 D1=108")
    print("  T5 x=8  -> no republish (value unchanged)")


if __name__ == "__main__":
    main()
