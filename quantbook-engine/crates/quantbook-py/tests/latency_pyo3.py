#!/usr/bin/env python3
"""FE-1-0/FE-1-1 latency shootout — the in-process PyO3 leg (the LOWER BOUND).

Topology: the owning WorkbookSession is embedded in THIS Python process via the
pyo3 facade (`_quantbook.Session`). Zero IPC — the sharpest fail-cheap probe on
Python<->engine latency. If even this misses the <100ms gate, the moat is dead
regardless of transport; M2 (the out-of-process legs) need not be built.

Loads the compiled extension by PATH (mirroring golden_flow.py): prefer a fresh
`cargo build -p quantbook-py` artifact, then the committed abi3 wheel artifact.
No maturin needed (pyo3 extension-module => the cdylib doesn't link libpython).

Run (Mac host):
    cargo build -p quantbook-py --release      # or use the prebuilt abi3.so
    python3 crates/quantbook-py/tests/latency_pyo3.py
Override the cdylib with QL_PY_CDYLIB=/abs/path/to/libquantbook_py.{dylib,so}.
"""

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
        # committed prebuilt abi3 artifact (explicit known-good location):
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
    print(f"[pyo3] loading extension: {cdylib}", file=sys.stderr)
    staging = Path(tempfile.mkdtemp(prefix="qbpy_latency_"))
    target = staging / "_quantbook.so"
    shutil.copy2(cdylib, target)
    sys.path.insert(0, str(staging))
    import _quantbook  # noqa: E402
    return _quantbook


def main():
    qb = _load_quantbook()
    s = qb.Session()
    sheet = s.add_sheet("Bench", 1000)
    s.set_formula(sheet, 0, 1, "A1+1")          # B1 = A1+1 (dependent => real recalc)
    s.set_value(sheet, 0, 0, {"kind": "number", "number": 0.0})
    s.recalc_dirty()
    version = s.snapshot()["version"]           # seed delta token (bytes)

    # ---- Workload A: single-edit round-trip ----
    a_totals, a_write, a_recalc, a_delta = [], [], [], []
    a_min_delta_cells = float("inf")
    last_a1 = 0
    for i in range(lc.WARMUP_A + lc.ITERS_A):
        timed = i >= lc.WARMUP_A
        last_a1 = i + 1
        t0 = lc.now_ms()
        s.set_value(sheet, 0, 0, {"kind": "number", "number": float(last_a1)})
        t1 = lc.now_ms()
        s.recalc_dirty()
        t2 = lc.now_ms()
        delta = s.snapshot_delta(version)
        t3 = lc.now_ms()
        version = delta["version"]
        if timed:
            a_totals.append(t3 - t0); a_write.append(t1 - t0)
            a_recalc.append(t2 - t1); a_delta.append(t3 - t2)
            a_min_delta_cells = min(a_min_delta_cells, len(delta["changedCells"]))
    # correctness guard (No-Fallbacks: fail loud if we measured a no-op):
    if a_min_delta_cells < 1:
        raise SystemExit("[pyo3] invalid: a Workload-A delta carried 0 changed cells")
    b1 = s.cell(sheet, 0, 1)
    if not b1 or not b1.get("value") or b1["value"].get("number") != last_a1 + 1:
        raise SystemExit(f"[pyo3] invalid: B1 (=A1+1) expected {last_a1 + 1}, got {b1.get('value') if b1 else None}")

    # ---- Workload B: 1000-cell batch paste ----
    rng = {
        "sheet": sheet,
        "startRow": lc.BATCH_BASE_ROW,
        "startCol": 0,
        "endRow": lc.BATCH_BASE_ROW + lc.BATCH_ROWS - 1,
        "endCol": lc.BATCH_COLS - 1,
    }
    b_totals, b_write, b_recalc, b_delta = [], [], [], []
    b_min_delta_cells = float("inf")
    last_batch_base = 0
    for i in range(lc.WARMUP_B + lc.ITERS_B):
        timed = i >= lc.WARMUP_B
        last_batch_base = i * 1000
        values = [
            [{"kind": "number", "number": float(last_batch_base + r * lc.BATCH_COLS + c)}
             for c in range(lc.BATCH_COLS)]
            for r in range(lc.BATCH_ROWS)
        ]
        t0 = lc.now_ms()
        s.write_range(rng, values)
        t1 = lc.now_ms()
        s.recalc_dirty()
        t2 = lc.now_ms()
        delta = s.snapshot_delta(version)
        t3 = lc.now_ms()
        version = delta["version"]
        if timed:
            b_totals.append(t3 - t0); b_write.append(t1 - t0)
            b_recalc.append(t2 - t1); b_delta.append(t3 - t2)
            b_min_delta_cells = min(b_min_delta_cells, len(delta["changedCells"]))
    if b_min_delta_cells < 1:
        raise SystemExit("[pyo3] invalid: a Workload-B delta carried 0 changed cells")
    corner = s.cell(sheet, lc.BATCH_BASE_ROW, 0)
    if not corner or not corner.get("value") or corner["value"].get("number") != float(last_batch_base):
        raise SystemExit(f"[pyo3] invalid: batch corner expected {last_batch_base}, got {corner.get('value') if corner else None}")

    report = lc.build_report(
        "pyo3", "engine-in-python",
        a_totals, {"write": a_write, "recalc": a_recalc, "delta": a_delta},
        b_totals, {"write": b_write, "recalc": b_recalc, "delta": b_delta},
    )
    lc.emit(report)


if __name__ == "__main__":
    main()
