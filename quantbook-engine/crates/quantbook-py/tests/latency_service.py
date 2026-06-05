#!/usr/bin/env python3
"""FE-1-0/FE-1-1 latency shootout — the ql-service HTTP leg (decoupled topology).

Topology: the owning WorkbookSession lives in a STANDALONE ql-service process;
Python (and, in the real product, the Node grid) are HTTP clients. Launches the
`ql-service` binary on an ephemeral port and drives the identical workload over
HTTP/1.1, reusing ONE persistent keep-alive connection (http.client) so we
measure real per-request transport cost — not TCP setup amortised per call.
(The golden_flow_service.py donor uses per-call urllib for correctness, not perf.)

Run (Mac host):
    cargo build -p ql-service --release
    python3 crates/quantbook-py/tests/latency_service.py
Override the binary with QL_SERVICE_BIN=/abs/path/to/ql-service.
"""

import http.client
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve()
_WORKSPACE_ROOT = _HERE.parents[3]
sys.path.insert(0, str(_WORKSPACE_ROOT / "bench"))
import latency_common as lc  # noqa: E402


# --- locate + launch the ql-service binary (release preferred for perf) -------

def _resolve_binary() -> Path:
    env = os.environ.get("QL_SERVICE_BIN")
    if env:
        p = Path(env)
        if not p.exists():
            raise SystemExit(f"QL_SERVICE_BIN does not exist: {p}")
        return p
    exe = "ql-service.exe" if sys.platform == "win32" else "ql-service"
    for sub in ("release", "debug"):
        c = _WORKSPACE_ROOT / "target" / sub / exe
        if c.exists():
            return c
    raise SystemExit(
        "built ql-service binary not found. Run `cargo build -p ql-service --release` first.\n"
        f"Looked in: {_WORKSPACE_ROOT / 'target' / 'release' / exe}"
    )


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _wait_ready(port: int, proc: subprocess.Popen, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            err = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
            raise RuntimeError(f"ql-service exited early ({proc.returncode}):\n{err}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.05)
    raise RuntimeError(f"ql-service did not become ready on port {port} within {timeout}s")


def _terminate(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def _launch_ready(binary: Path, attempts: int = 3):
    last_err = ""
    for _ in range(attempts):
        port = _free_port()
        env = {**os.environ, "QL_SERVICE_PORT": str(port)}
        proc = subprocess.Popen(
            [str(binary)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
        )
        try:
            _wait_ready(port, proc)
            return proc, port
        except RuntimeError as e:
            last_err = str(e)
            _terminate(proc)
    raise SystemExit(f"ql-service failed to become ready after {attempts} attempts: {last_err}")


# --- persistent keep-alive HTTP client ---------------------------------------

class Client:
    def __init__(self, port: int):
        self.conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)

    def call(self, method: str, path: str, body=None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json", "Connection": "keep-alive"}
        self.conn.request(method, path, body=data, headers=headers)
        resp = self.conn.getresponse()
        raw = resp.read()  # MUST drain so the connection can be reused
        if not (200 <= resp.status < 300):
            raise SystemExit(f"{method} {path} -> HTTP {resp.status}: {raw[:400]!r}")
        return json.loads(raw) if raw else None

    def close(self):
        self.conn.close()


def main():
    binary = _resolve_binary()
    print(f"[service] launching: {binary}", file=sys.stderr)
    proc, port = _launch_ready(binary)
    try:
        c = Client(port)
        sid = c.call("POST", "/v1/sessions")["sessionId"]
        base = f"/v1/sessions/{sid}"
        sheet = c.call("POST", f"{base}/add-sheet", {"name": "Bench", "chunkRows": 1000})["sheetId"]
        c.call("POST", f"{base}/set-formula", {"sheet": sheet, "row": 0, "col": 1, "text": "A1+1"})
        c.call("POST", f"{base}/set-value",
               {"sheet": sheet, "row": 0, "col": 0, "value": {"kind": "number", "number": 0}})
        c.call("POST", f"{base}/recalc?kind=dirty")
        version = c.call("GET", f"{base}/snapshot")["version"]

        # ---- Workload A: single-edit round-trip ----
        a_totals, a_write, a_recalc, a_delta = [], [], [], []
        a_min_delta_cells = float("inf")
        last_a1 = 0
        for i in range(lc.WARMUP_A + lc.ITERS_A):
            timed = i >= lc.WARMUP_A
            last_a1 = i + 1
            t0 = lc.now_ms()
            c.call("POST", f"{base}/set-value",
                   {"sheet": sheet, "row": 0, "col": 0, "value": {"kind": "number", "number": last_a1}})
            t1 = lc.now_ms()
            c.call("POST", f"{base}/recalc?kind=dirty")
            t2 = lc.now_ms()
            delta = c.call("POST", f"{base}/snapshot-delta", {"version": version})
            t3 = lc.now_ms()
            version = delta["version"]
            if timed:
                a_totals.append(t3 - t0); a_write.append(t1 - t0)
                a_recalc.append(t2 - t1); a_delta.append(t3 - t2)
                a_min_delta_cells = min(a_min_delta_cells, len(delta["changedCells"]))
        if a_min_delta_cells < 1:
            raise SystemExit("[service] invalid: a Workload-A delta carried 0 changed cells")
        b1 = c.call("POST", f"{base}/cell", {"sheet": sheet, "row": 0, "col": 1})["value"]
        if not b1 or b1.get("number") != last_a1 + 1:
            raise SystemExit(f"[service] invalid: B1 (=A1+1) expected {last_a1 + 1}, got {b1}")

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
                [{"kind": "number", "number": last_batch_base + r * lc.BATCH_COLS + c}
                 for c in range(lc.BATCH_COLS)]
                for r in range(lc.BATCH_ROWS)
            ]
            t0 = lc.now_ms()
            c.call("POST", f"{base}/write-range", {"range": rng, "values": values})
            t1 = lc.now_ms()
            c.call("POST", f"{base}/recalc?kind=dirty")
            t2 = lc.now_ms()
            delta = c.call("POST", f"{base}/snapshot-delta", {"version": version})
            t3 = lc.now_ms()
            version = delta["version"]
            if timed:
                b_totals.append(t3 - t0); b_write.append(t1 - t0)
                b_recalc.append(t2 - t1); b_delta.append(t3 - t2)
                b_min_delta_cells = min(b_min_delta_cells, len(delta["changedCells"]))
        if b_min_delta_cells < 1:
            raise SystemExit("[service] invalid: a Workload-B delta carried 0 changed cells")
        corner = c.call("POST", f"{base}/cell", {"sheet": sheet, "row": lc.BATCH_BASE_ROW, "col": 0})["value"]
        if not corner or corner.get("number") != last_batch_base:
            raise SystemExit(f"[service] invalid: batch corner expected {last_batch_base}, got {corner}")

        c.close()
        report = lc.build_report(
            "service", "standalone-http",
            a_totals, {"write": a_write, "recalc": a_recalc, "delta": a_delta},
            b_totals, {"write": b_write, "recalc": b_recalc, "delta": b_delta},
        )
        lc.emit(report)
    finally:
        _terminate(proc)


if __name__ == "__main__":
    main()
