#!/usr/bin/env python3
"""FE-1.5-0 reactive-recalc latency — the REAL shipped-topology leg.

Same reactive path as latency_reactive_pyo3.py (publish_dataset -> dirty dependents
-> recalc_dirty -> snapshot_delta), but driven over the actual product topology:
a Python client drives a Node "engine host" (latency_node_host.mjs) that owns the
napi WorkbookSession in its own process -- Python kernel <-> Node extension host
(owns the engine) <-> engine. This is the leg whose number speaks to the shipped
FE-2-0 grid topology, not a clean in-process measurement.

The reactive PROOF is identical: each delta must carry the DEPENDENT cell (a formula
publish_dataset never wrote), proving recalc recomputed it after publish dirtied it.

Run (Mac host):
    export PATH="$HOME/.cargo/bin:$PATH" && cargo build -p ql-bindings-node --release
    python3.12 crates/quantbook-py/tests/latency_reactive_nodehost.py
Needs `node` on PATH; the host resolves the cdylib itself (or QL_NODE_CDYLIB).
"""

import json
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve()
_WORKSPACE_ROOT = _HERE.parents[3]
sys.path.insert(0, str(_WORKSPACE_ROOT / "bench"))
import latency_common as lc  # noqa: E402

_HOST = _WORKSPACE_ROOT / "crates" / "ql-bindings-node" / "tests" / "latency_node_host.mjs"


class Host:
    def __init__(self):
        self.proc = subprocess.Popen(
            ["node", str(_HOST)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            bufsize=1, text=True,
        )

    def call(self, **req):
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read()
            raise SystemExit(f"node host died (op={req.get('op')}):\n{err}")
        resp = json.loads(line)
        if isinstance(resp, dict) and "error" in resp:
            raise SystemExit(f"node host error (op={req.get('op')}): {resp['error']}")
        return resp

    def close(self):
        try:
            self.call(op="close")
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()


def _find_cell(changed, row, col):
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
    h = Host()
    try:
        sheet = h.call(op="addSheet", name="Bench", chunkRows=1000)["sheetId"]

        # Workload A dependent: C1 = B1*2 (B1 = publish target; C1 = reactive dependent)
        A_PUB = {"sheet": sheet, "startRow": 0, "startCol": 1, "endRow": 0, "endCol": 1}
        A_DEP_ROW, A_DEP_COL = 0, 2
        h.call(op="setFormula", sheet=sheet, row=A_DEP_ROW, col=A_DEP_COL, text="B1*2")

        # Workload B dependents: per-row sum of the published 100x10 frame in col K (10),
        # as an explicit 10-term cell-ref sum A{n}+...+J{n} (literal SUM(range) is a v1
        # binder defer; the binding exposes no named-range API). 100 dependents recompute.
        B_DEP_COL = lc.BATCH_COLS
        for r in range(lc.BATCH_ROWS):
            sheet_row = lc.BATCH_BASE_ROW + r
            a1_row = sheet_row + 1
            h.call(op="setFormula", sheet=sheet, row=sheet_row, col=B_DEP_COL,
                   text=_row_sum_formula(a1_row))

        # seed once (cursor is kept inside the host; first snapshotDelta defines the baseline)
        h.call(op="publishDataset", name="a", data=json.dumps({"values": [[0]]}), target=A_PUB)
        h.call(op="recalc")
        h.call(op="snapshotDelta")

        # ---- Workload A: reactive single-publish round-trip ----
        a_totals, a_write, a_recalc, a_delta = [], [], [], []
        a_dep_seen = 0
        last_v = 0
        for i in range(lc.WARMUP_A + lc.ITERS_A):
            timed = i >= lc.WARMUP_A
            last_v = i + 1
            t0 = lc.now_ms()
            h.call(op="publishDataset", name="a", data=json.dumps({"values": [[last_v]]}), target=A_PUB)
            t1 = lc.now_ms()
            h.call(op="recalc")
            t2 = lc.now_ms()
            delta = h.call(op="snapshotDelta")
            t3 = lc.now_ms()
            if timed:
                a_totals.append(t3 - t0); a_write.append(t1 - t0)
                a_recalc.append(t2 - t1); a_delta.append(t3 - t2)
                if _find_cell(delta["changedCells"], A_DEP_ROW, A_DEP_COL) is not None:
                    a_dep_seen += 1
        if a_dep_seen != lc.ITERS_A:
            raise SystemExit(
                f"[reactive-nodehost] invalid: dependent C1 reactively recomputed in only "
                f"{a_dep_seen}/{lc.ITERS_A} Workload-A deltas (expected all)"
            )
        c1 = h.call(op="cell", sheet=sheet, row=A_DEP_ROW, col=A_DEP_COL)["cell"]
        if _num(c1) != last_v * 2:
            raise SystemExit(f"[reactive-nodehost] invalid: C1 (=B1*2) expected {last_v * 2}, got {_num(c1)}")

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
            h.call(op="publishDataset", name="frame", data=json.dumps({"values": matrix}), target=B_TGT)
            t1 = lc.now_ms()
            h.call(op="recalc")
            t2 = lc.now_ms()
            delta = h.call(op="snapshotDelta")
            t3 = lc.now_ms()
            if timed:
                b_totals.append(t3 - t0); b_write.append(t1 - t0)
                b_recalc.append(t2 - t1); b_delta.append(t3 - t2)
                # REACTIVE PROOF: ALL 100 row-sum dependents (the entire K column) must
                # reactively recompute each publish -- not just the first (untimed; after t3).
                if _rows_at_col(delta["changedCells"], B_DEP_COL) == B_DEP_ROWS:
                    b_dep_seen += 1
        if b_dep_seen != lc.ITERS_B:
            raise SystemExit(
                f"[reactive-nodehost] invalid: not all {lc.BATCH_ROWS} row-SUM dependents reactively "
                f"recomputed in {lc.ITERS_B - b_dep_seen}/{lc.ITERS_B} Workload-B deltas (expected all)"
            )
        dep = h.call(op="cell", sheet=sheet, row=lc.BATCH_BASE_ROW, col=B_DEP_COL)["cell"]
        expected = 10 * last_base + 45
        if _num(dep) != expected:
            raise SystemExit(f"[reactive-nodehost] invalid: row-SUM dependent expected {expected}, got {_num(dep)}")

        report = lc.build_report(
            "reactive-nodehost", "python->node-napi (publish->recalc)",
            a_totals, {"write": a_write, "recalc": a_recalc, "delta": a_delta},
            b_totals, {"write": b_write, "recalc": b_recalc, "delta": b_delta},
        )
        lc.emit(report)
    finally:
        h.close()


if __name__ == "__main__":
    main()
