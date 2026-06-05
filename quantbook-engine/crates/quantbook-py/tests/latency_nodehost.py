#!/usr/bin/env python3
"""FE-1 latency shootout — the REAL shipped-topology leg.

Python client driving a Node "engine host" (latency_node_host.mjs) that owns the
napi WorkbookSession in its own process — i.e. the exact FE-2-0 product path:
Python kernel <-> Node extension host (owns the engine) <-> engine. Communicates
over the Node child's stdio with newline-delimited JSON. This is the leg that
removes the doc's caveat-#2 extrapolation (the in-process/HTTP legs measured
clean topologies; this measures engine-in-Node + Python-as-client directly).

Run (Mac host): cargo build -p ql-bindings-node --release
    python3.12 crates/quantbook-py/tests/latency_nodehost.py
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


def main():
    h = Host()
    try:
        sheet = h.call(op="addSheet", name="Bench", chunkRows=1000)["sheetId"]
        h.call(op="setFormula", sheet=sheet, row=0, col=1, text="A1+1")
        h.call(op="setValue", sheet=sheet, row=0, col=0, value={"kind": "number", "number": 0})
        h.call(op="recalc")

        # ---- Workload A ----
        a_totals, a_write, a_recalc, a_delta = [], [], [], []
        a_min_delta_cells = float("inf")
        last_a1 = 0
        for i in range(lc.WARMUP_A + lc.ITERS_A):
            timed = i >= lc.WARMUP_A
            last_a1 = i + 1
            t0 = lc.now_ms()
            h.call(op="setValue", sheet=sheet, row=0, col=0, value={"kind": "number", "number": last_a1})
            t1 = lc.now_ms()
            h.call(op="recalc")
            t2 = lc.now_ms()
            delta = h.call(op="snapshotDelta")
            t3 = lc.now_ms()
            if timed:
                a_totals.append(t3 - t0); a_write.append(t1 - t0)
                a_recalc.append(t2 - t1); a_delta.append(t3 - t2)
                a_min_delta_cells = min(a_min_delta_cells, len(delta["changedCells"]))
        if a_min_delta_cells < 1:
            raise SystemExit("[nodehost] invalid: a Workload-A delta carried 0 changed cells")
        b1 = h.call(op="cell", sheet=sheet, row=0, col=1)["cell"]
        if not b1 or not b1.get("value") or b1["value"].get("number") != last_a1 + 1:
            raise SystemExit(f"[nodehost] invalid: B1 expected {last_a1 + 1}, got {b1.get('value') if b1 else None}")

        # ---- Workload B ----
        rng = {"sheet": sheet, "startRow": lc.BATCH_BASE_ROW, "startCol": 0,
               "endRow": lc.BATCH_BASE_ROW + lc.BATCH_ROWS - 1, "endCol": lc.BATCH_COLS - 1}
        b_totals, b_write, b_recalc, b_delta = [], [], [], []
        b_min_delta_cells = float("inf")
        last_batch_base = 0
        for i in range(lc.WARMUP_B + lc.ITERS_B):
            timed = i >= lc.WARMUP_B
            last_batch_base = i * 1000
            values = [
                [{"kind": "number", "number": last_batch_base + r * lc.BATCH_COLS + c}
                 for c in range(lc.BATCH_COLS)]
                for r in range(lc.BATCH_ROWS)
            ]
            t0 = lc.now_ms()
            h.call(op="writeRange", range=rng, values=values)
            t1 = lc.now_ms()
            h.call(op="recalc")
            t2 = lc.now_ms()
            delta = h.call(op="snapshotDelta")
            t3 = lc.now_ms()
            if timed:
                b_totals.append(t3 - t0); b_write.append(t1 - t0)
                b_recalc.append(t2 - t1); b_delta.append(t3 - t2)
                b_min_delta_cells = min(b_min_delta_cells, len(delta["changedCells"]))
        if b_min_delta_cells < 1:
            raise SystemExit("[nodehost] invalid: a Workload-B delta carried 0 changed cells")
        corner = h.call(op="cell", sheet=sheet, row=lc.BATCH_BASE_ROW, col=0)["cell"]
        if not corner or not corner.get("value") or corner["value"].get("number") != last_batch_base:
            raise SystemExit(f"[nodehost] invalid: batch corner expected {last_batch_base}, got {corner.get('value') if corner else None}")

        report = lc.build_report(
            "nodehost", "python->node-napi",
            a_totals, {"write": a_write, "recalc": a_recalc, "delta": a_delta},
            b_totals, {"write": b_write, "recalc": b_recalc, "delta": b_delta},
        )
        lc.emit(report)
    finally:
        h.close()


if __name__ == "__main__":
    main()
