#!/usr/bin/env python3
"""FE-1.5-0 reactive-recalc latency — the in-process PyO3 leg (LOWER BOUND).

The FE-1 shootout measured DIRECT edits (set_value/write_range -> recalc -> delta).
This measures the REACTIVE MOAT path instead:

    publish_dataset(name, {"values": [[..]]}, target)   # a Python var/frame published
      -> engine WRITES the target AND dirties the DEPENDENT formula cells in-place
    recalc_dirty()                                       # recompute the dirtied dependents
    snapshot_delta(version)                              # the dependents surface here

The reactive PROOF (not a write echo): each iteration asserts the DEPENDENT cell
-- a formula cell that publish_dataset never wrote -- is present in the delta. It
can only be there because recalc recomputed it after publish dirtied it.

Topology: the owning WorkbookSession is embedded in THIS Python process via the
pyo3 facade. Zero IPC -- the lower bound on reactive publish->recalc latency.

Run (Mac host):
    export PATH="$HOME/.cargo/bin:$PATH" && cargo build -p quantbook-py --release
    python3.12 crates/quantbook-py/tests/latency_reactive_pyo3.py
(pyo3 abi3 needs python3.12; the macOS system python3 is 3.9 -> _Py_NewRef missing.)
Override the cdylib with QL_PY_CDYLIB=/abs/path/to/libquantbook_py.{dylib,so}.
"""

import json
import shutil
import sys
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve()
_WORKSPACE_ROOT = _HERE.parents[3]  # crates/quantbook-py/tests -> root
sys.path.insert(0, str(_WORKSPACE_ROOT / "bench"))
import latency_common as lc  # noqa: E402


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
    print(f"[reactive-pyo3] loading extension: {cdylib}", file=sys.stderr)
    staging = Path(tempfile.mkdtemp(prefix="qbpy_reactive_"))
    target = staging / "_quantbook.so"
    shutil.copy2(cdylib, target)
    sys.path.insert(0, str(staging))
    import _quantbook  # noqa: E402
    return _quantbook


def _find_cell(changed, row, col):
    """changedCells entries are {"cell": {"row","col","value"}} -> the dependent or None."""
    for cc in changed:
        c = cc.get("cell")
        if c and c.get("row") == row and c.get("col") == col:
            return c
    return None


def _num(cell):
    v = cell.get("value") if cell else None
    return v.get("number") if v else None


def _row_sum_formula(a1_row):
    """A{n}+B{n}+...+J{n} over the BATCH_COLS published columns (single-cell refs only)."""
    return "+".join(f"{chr(65 + c)}{a1_row}" for c in range(lc.BATCH_COLS))


def _rows_at_col(changed, col):
    """Set of rows whose changed cell is in `col` (the dependent column for Workload B)."""
    return {cc["cell"]["row"] for cc in changed
            if cc.get("cell") and cc["cell"].get("col") == col}


def main():
    qb = _load_quantbook()
    s = qb.Session()
    sheet = s.add_sheet("Bench", 1000)

    # --- Workload A dependent: C1 = B1*2 (B1 is the publish target; C1 is the
    #     reactive dependent publish_dataset never writes) ---
    A_PUB = {"sheet": sheet, "startRow": 0, "startCol": 1, "endRow": 0, "endCol": 1}  # B1
    A_DEP_ROW, A_DEP_COL = 0, 2                                                        # C1
    s.set_formula(sheet, A_DEP_ROW, A_DEP_COL, "B1*2")

    # --- Workload B dependents: per-row sum of the published frame, as an explicit
    #     10-term CELL-REF sum (A{n}+B{n}+...+J{n}). A literal range `SUM(A{n}:J{n})`
    #     is a documented v1 binder defer (AggregateArg-side literal RangeRef), and the
    #     binding exposes no named-range API; individual cell refs are the proven form
    #     (cf. core test publish_dataset_dirties_dependents, `B1*2`). Frame = rows 10..109
    #     x cols A..J (0..9) = 1000 cells; dependents in col K (10), one per row -> 100
    #     dependents reactively recompute per frame publish. ---
    B_DEP_COL = lc.BATCH_COLS  # col 10 (K), just past the published frame
    for r in range(lc.BATCH_ROWS):
        sheet_row = lc.BATCH_BASE_ROW + r
        a1_row = sheet_row + 1  # A1-style 1-based
        s.set_formula(sheet, sheet_row, B_DEP_COL, _row_sum_formula(a1_row))

    # seed everything once, then capture the delta cursor
    s.publish_dataset("a", json.dumps({"values": [[0]]}), A_PUB)
    s.recalc_dirty()
    version = s.snapshot()["version"]

    # ---- Workload A: reactive single-publish round-trip ----
    a_totals, a_write, a_recalc, a_delta = [], [], [], []
    a_dep_seen = 0
    last_v = 0
    for i in range(lc.WARMUP_A + lc.ITERS_A):
        timed = i >= lc.WARMUP_A
        last_v = i + 1
        t0 = lc.now_ms()
        s.publish_dataset("a", json.dumps({"values": [[last_v]]}), A_PUB)
        t1 = lc.now_ms()
        s.recalc_dirty()
        t2 = lc.now_ms()
        delta = s.snapshot_delta(version)
        t3 = lc.now_ms()
        version = delta["version"]
        if timed:
            a_totals.append(t3 - t0); a_write.append(t1 - t0)
            a_recalc.append(t2 - t1); a_delta.append(t3 - t2)
            # REACTIVE PROOF: the dependent C1 must be in every delta (it was recomputed,
            # not written by publish). Fail loud if the reactive path silently no-ops.
            if _find_cell(delta["changedCells"], A_DEP_ROW, A_DEP_COL) is not None:
                a_dep_seen += 1
    if a_dep_seen != lc.ITERS_A:
        raise SystemExit(
            f"[reactive-pyo3] invalid: dependent C1 reactively recomputed in only "
            f"{a_dep_seen}/{lc.ITERS_A} Workload-A deltas (expected all)"
        )
    c1 = s.cell(sheet, A_DEP_ROW, A_DEP_COL)
    if _num(c1) != last_v * 2:
        raise SystemExit(f"[reactive-pyo3] invalid: C1 (=B1*2) expected {last_v * 2}, got {_num(c1)}")

    # ---- Workload B: reactive 1000-cell frame publish ----
    B_TGT = {"sheet": sheet, "startRow": lc.BATCH_BASE_ROW, "startCol": 0,
             "endRow": lc.BATCH_BASE_ROW + lc.BATCH_ROWS - 1, "endCol": lc.BATCH_COLS - 1}
    B_DEP_ROWS = frozenset(range(lc.BATCH_BASE_ROW, lc.BATCH_BASE_ROW + lc.BATCH_ROWS))  # all 100 K-cells
    b_totals, b_write, b_recalc, b_delta = [], [], [], []
    b_dep_seen = 0
    last_base = 0
    for i in range(lc.WARMUP_B + lc.ITERS_B):
        timed = i >= lc.WARMUP_B
        last_base = i * 1000
        matrix = [
            [last_base + r * lc.BATCH_COLS + c for c in range(lc.BATCH_COLS)]
            for r in range(lc.BATCH_ROWS)
        ]
        t0 = lc.now_ms()
        s.publish_dataset("frame", json.dumps({"values": matrix}), B_TGT)
        t1 = lc.now_ms()
        s.recalc_dirty()
        t2 = lc.now_ms()
        delta = s.snapshot_delta(version)
        t3 = lc.now_ms()
        version = delta["version"]
        if timed:
            b_totals.append(t3 - t0); b_write.append(t1 - t0)
            b_recalc.append(t2 - t1); b_delta.append(t3 - t2)
            # REACTIVE PROOF: ALL 100 row-sum dependents (the entire K column) must
            # reactively recompute each publish -- not just the first (untimed; after t3).
            if _rows_at_col(delta["changedCells"], B_DEP_COL) == B_DEP_ROWS:
                b_dep_seen += 1
    if b_dep_seen != lc.ITERS_B:
        raise SystemExit(
            f"[reactive-pyo3] invalid: not all {lc.BATCH_ROWS} row-SUM dependents reactively "
            f"recomputed in {lc.ITERS_B - b_dep_seen}/{lc.ITERS_B} Workload-B deltas (expected all)"
        )
    # first published row = [base..base+9]; its SUM = 10*base + 45
    dep = s.cell(sheet, lc.BATCH_BASE_ROW, B_DEP_COL)
    expected = 10 * last_base + 45
    if _num(dep) != expected:
        raise SystemExit(f"[reactive-pyo3] invalid: row-SUM dependent expected {expected}, got {_num(dep)}")

    report = lc.build_report(
        "reactive-pyo3", "engine-in-python (publish->recalc)",
        a_totals, {"write": a_write, "recalc": a_recalc, "delta": a_delta},
        b_totals, {"write": b_write, "recalc": b_recalc, "delta": b_delta},
    )
    lc.emit(report)


if __name__ == "__main__":
    main()
