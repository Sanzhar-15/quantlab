#!/usr/bin/env python3
"""Phase 6.2-4 -- the SERVICE (ql-service HTTP) row of the golden parity matrix.

Launches the `ql-service` DEBUG binary as a subprocess on an ephemeral port and
drives the SAME canonical 23-step golden flow as `golden_flow.py` (pyo3) and
`golden_flow.mjs` (napi), over real HTTP/1.1 using only the stdlib (`urllib`).
Emits the CANONICAL JSON transcript (one ordered list of step records) to stdout;
`parity_matrix.py` runs all three rows and asserts the transcripts agree (masking
engine-internal opaque ids / version tokens). This row proves the wire DTO layer
matches the frozen napi shape -- including the ECMAScript number rendering resolved
in 6.2-4 (cell numbers cross as `6`, not serde `6.0`).

DEBUG binary because the `__force_panic` route (step 18) is `#[cfg(debug_assertions)]`.
Build first on the Mac host:

    cargo build -p ql-service          # debug (has the __force_panic probe)
    python3.12 crates/quantbook-py/tests/golden_flow_service.py

Override the binary path with QL_SERVICE_BIN=/abs/path/to/ql-service.
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


# --- locate + launch the ql-service debug binary -----------------------------

def _resolve_binary() -> Path:
    env = os.environ.get("QL_SERVICE_BIN")
    if env:
        p = Path(env)
        if not p.exists():
            raise SystemExit(f"QL_SERVICE_BIN does not exist: {p}")
        return p
    here = Path(__file__).resolve()
    # crates/quantbook-py/tests -> ../../.. = the cargo workspace root.
    workspace_root = here.parents[3]
    exe = "ql-service.exe" if sys.platform == "win32" else "ql-service"
    candidate = workspace_root / "target" / "debug" / exe
    if candidate.exists():
        return candidate
    raise SystemExit(
        "built ql-service binary not found. Run `cargo build -p ql-service` first.\n"
        f"Looked in: {candidate}"
    )


def _free_port() -> int:
    """Reserve an ephemeral port, then release it for the child to bind."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _wait_ready(port: int, proc: subprocess.Popen, timeout: float = 10.0) -> None:
    """Poll until the listener accepts a TCP connection. Raises RuntimeError if the
    child dies early (e.g. a port-bind race) or does not become ready -- the caller
    retries on a fresh port."""
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
    """Stop the child, escalating to kill; always reap (no zombie)."""
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def _launch_ready(binary: Path, attempts: int = 3):
    """Launch the service on a fresh ephemeral port and wait for readiness, retrying on
    the (rare) reserve-release port race where another process grabs the freed port
    before the child binds it."""
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


# --- HTTP client (stdlib) -----------------------------------------------------

class Client:
    def __init__(self, port: int):
        self.base = f"http://127.0.0.1:{port}"

    def call(self, method: str, path: str, body=None, allow_error: bool = False):
        url = f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        parsed = json.loads(raw) if raw else None
        # Happy-path calls assert 2xx so a mid-flow failure fails LOUD (not a vacuous
        # pass): an error body that happened to share keys with the success shape would
        # otherwise slip through. Deliberate-error calls opt out via allow_error.
        if not allow_error and not (200 <= status < 300):
            raise SystemExit(f"{method} {path} -> HTTP {status}: {parsed}")
        return status, parsed

    def code_of(self, method: str, path: str, body=None) -> str:
        """Issue a request expected to fail; return the problem+json `code`."""
        status, parsed = self.call(method, path, body, allow_error=True)
        if 200 <= status < 300:
            return "<did-not-throw>"
        if isinstance(parsed, dict) and isinstance(parsed.get("code"), str):
            return parsed["code"]
        return "<no-code>"


# --- the canonical golden flow ------------------------------------------------

def run(c: Client) -> list:
    out = []

    def rec(step, **kw):
        out.append({"step": step, **kw})

    # session-per-connection: one session id used across the flow.
    st, b = c.call("POST", "/v1/sessions")
    assert st == 201, f"create session: {st} {b}"
    sid = b["sessionId"]
    base = f"/v1/sessions/{sid}"

    rec("lifecycle_initial", value=c.call("GET", f"{base}/lifecycle")[1]["state"])

    # --- new sheet + edits ---
    sh = c.call("POST", f"{base}/add-sheet", {"name": "Sheet1", "chunkRows": 1000})[1]["sheetId"]
    rec("add_sheet", value=sh)
    c.call("POST", f"{base}/set-value", {"sheet": sh, "row": 0, "col": 0, "value": {"kind": "number", "number": 10}})
    c.call("POST", f"{base}/set-formula", {"sheet": sh, "row": 0, "col": 1, "text": "A1+1"})
    # FIRST recalc op id is deterministically "1" (engine next_op_id starts at 1) -> UNMASKED witness.
    first_recalc_op = c.call("POST", f"{base}/recalc?kind=dirty")[1]["op"]
    rec("recalc_op_id", value=first_recalc_op)
    rec("recalc", value="<opid>" if first_recalc_op is not None else None)
    rec("b1_value", value=c.call("POST", f"{base}/cell", {"sheet": sh, "row": 0, "col": 1})[1]["value"])

    # --- snapshot ---
    snap = c.call("GET", f"{base}/snapshot")[1]
    rec("snapshot", sheets=len(snap["sheets"]), schemaVersion=snap["schemaVersion"])

    # --- snapshot_delta: incremental (set_value does NOT bump the epoch) ---
    v_before = c.call("GET", f"{base}/snapshot")[1]["version"]
    c.call("POST", f"{base}/set-value", {"sheet": sh, "row": 5, "col": 5, "value": {"kind": "number", "number": 77}})
    c.call("POST", f"{base}/recalc?kind=dirty")
    delta = c.call("POST", f"{base}/snapshot-delta", {"version": v_before})[1]
    hit = next(
        (x for x in delta["changedCells"] if x["sheet"] == sh and x["cell"]["row"] == 5 and x["cell"]["col"] == 5),
        None,
    )
    rec(
        "delta_after_edit",
        fullRebuildRequired=delta["fullRebuildRequired"],
        schemaVersion=delta["schemaVersion"],
        hitCoord=([hit["cell"]["row"], hit["cell"]["col"]] if hit else None),
        # ["value"] (not .get) so a missing value fails loud identically to the
        # in-process rows, rather than the service silently substituting None.
        changedHit=(hit["cell"]["value"] if hit else None),
    )

    # --- snapshot_delta: empty token -> full rebuild (not an error) ---
    fr = c.call("POST", f"{base}/snapshot-delta", {"version": ""})[1]
    rec("delta_empty_token", fullRebuildRequired=fr["fullRebuildRequired"], reason=fr.get("fullRebuildReason"))

    # --- table (observed via a structured-reference formula) ---
    ts = c.call("POST", f"{base}/add-sheet", {"name": "TblSheet", "chunkRows": 1000})[1]["sheetId"]
    c.call("POST", f"{base}/set-value", {"sheet": ts, "row": 0, "col": 0, "value": {"kind": "text", "text": "Qty"}})
    c.call("POST", f"{base}/set-value", {"sheet": ts, "row": 1, "col": 0, "value": {"kind": "number", "number": 10}})
    c.call("POST", f"{base}/set-value", {"sheet": ts, "row": 2, "col": 0, "value": {"kind": "number", "number": 20}})
    c.call(
        "POST",
        f"{base}/create-table",
        {
            "name": "Sales",
            "sheet": ts,
            "topRow": 0,
            "topCol": 0,
            "rows": 3,
            "cols": 1,
            "hasHeader": True,
            "hasTotals": False,
            "columnNames": ["Qty"],
        },
    )
    c.call("POST", f"{base}/set-formula", {"sheet": ts, "row": 0, "col": 2, "text": "SUM(Sales[Qty])"})
    c.call("POST", f"{base}/recalc?kind=dirty")
    rec("table_sum", value=c.call("POST", f"{base}/cell", {"sheet": ts, "row": 0, "col": 2})[1]["value"])

    # --- batch (atomic, observable) ---
    res = c.call(
        "POST",
        f"{base}/batch",
        {
            "ops": [
                {"kind": "setValue", "sheet": sh, "row": 0, "col": 2, "value": {"kind": "number", "number": 5}},
                {"kind": "setFormula", "sheet": sh, "row": 0, "col": 3, "text": "C1*2"},
                {"kind": "setFormat", "sheet": sh, "row": 0, "col": 4, "format": {"kind": "builtin", "builtin": 0}},
            ],
            "options": {},
        },
    )[1]
    c.call("POST", f"{base}/recalc?kind=dirty")
    rec("batch_applied", value=res["applied"])
    rec("batch_d1", value=c.call("POST", f"{base}/cell", {"sheet": sh, "row": 0, "col": 3})[1]["value"])

    # --- undo / redo (observable) ---
    rec("can_undo_before", value=c.call("GET", f"{base}/can-undo")[1])
    u = c.call("POST", f"{base}/undo")[1]
    c.call("POST", f"{base}/recalc?kind=dirty")
    c1_after_undo = c.call("POST", f"{base}/cell", {"sheet": sh, "row": 0, "col": 2})[1]
    rec("undo", consumed=u["consumed"], c1=c1_after_undo)  # C1 reverted -> the cell snapshot
    r = c.call("POST", f"{base}/redo")[1]
    c.call("POST", f"{base}/recalc?kind=dirty")
    c1_cell = c.call("POST", f"{base}/cell", {"sheet": sh, "row": 0, "col": 2})[1]
    rec("redo", consumed=r["consumed"], c1=(c1_cell.get("value") if c1_cell else None))

    # --- persistence: save -> open in a fresh session -> value survives ---
    save_path = str(Path(tempfile.mkdtemp(prefix="qbsvc_golden_save_")) / "golden.qbook")
    c.call("POST", f"{base}/save", {"path": save_path})
    st2, b2 = c.call("POST", "/v1/sessions")
    sid2 = b2["sessionId"]
    base2 = f"/v1/sessions/{sid2}"
    c.call("POST", f"{base2}/open", {"path": save_path})
    c.call("POST", f"{base2}/recalc?kind=dirty")
    rec("persist_a1", value=c.call("POST", f"{base2}/cell", {"sheet": sh, "row": 0, "col": 0})[1]["value"])

    # --- function registration ---
    meta = {
        "canonicalName": "MYUDF",
        "aliases": [],
        "arity": {"kind": "variadic"},
        "volatility": "pure",
        "determinism": True,
        "depShape": "value_deps",
        "batchShape": "array_batch",
        "argPolicy": "strict",
        "cancellation": "cooperative",
        "argContext": "scalar",
        "provenanceTags": [],
    }
    c.call("POST", f"{base}/register-function", {"metadata": meta, "implHandle": "1"})
    fns = c.call("GET", f"{base}/functions")[1]
    myudf = next((f for f in fns if f["canonicalName"] == "MYUDF"), None)
    rec("register_udf", present=myudf is not None, total=len(fns), metadata=myudf)

    # --- events: poll from cursor 0 (>=1 event after the recalcs) ---
    page = c.call("GET", f"{base}/poll-events?cursor=0")[1]
    rec(
        "poll_events",
        count=len(page["events"]),
        dropped=page["dropped"],
        kinds=sorted({e["kind"] for e in page["events"]}),
    )

    # --- write_range (§3.5; 6.5-0 substrate): bulk-write a 1x2 range ---
    wr = c.call(
        "POST",
        f"{base}/write-range",
        {
            "range": {"sheet": sh, "startRow": 20, "startCol": 0, "endRow": 20, "endCol": 1},
            "values": [[{"kind": "number", "number": 10}, {"kind": "number", "number": 20}]],
        },
    )[1]
    rec("write_range", written=wr["written"])

    # --- materialize_query (§3.5; 6.5-1 substrate): SELECT 1 -> cell (sh, 20, 2) ---
    mq = c.call(
        "POST",
        f"{base}/materialize-query",
        {
            "queryId": "q1",
            "target": {"sheet": sh, "startRow": 20, "startCol": 2, "endRow": 20, "endCol": 2},
            "data": '{"sql":"SELECT 1 AS a"}',
        },
    )[1]
    rec("materialize_query", id=mq["id"])

    # --- refresh_source (§3.5): re-run q1 at revision 1; no formula dependents -> dirtied=0 ---
    rs = c.call(
        "POST",
        f"{base}/refresh-source",
        {"sourceId": "q1", "revision": "1"},
    )[1]
    rec("refresh_source", dirtied=rs["dirtied"])

    # --- deliberate panic on a SEPARATE session: surfaces, does NOT abort ---
    stp, bp = c.call("POST", "/v1/sessions")
    psid = bp["sessionId"]
    pbase = f"/v1/sessions/{psid}"
    rec("panic", error={"code": c.code_of("POST", f"{pbase}/__force_panic")})
    # Host still alive (we got here); session still answers a pure read.
    rec("after_panic_lifecycle", value=c.call("GET", f"{pbase}/lifecycle")[1]["state"])

    # --- error-path rows (stable codes) ---
    rec("err_dup_sheet", error={"code": c.code_of("POST", f"{base}/add-sheet", {"name": "Sheet1", "chunkRows": 1000})})
    rec(
        "err_bad_kind",
        error={"code": c.code_of("POST", f"{base}/set-value", {"sheet": sh, "row": 9, "col": 9, "value": {"kind": "bogus"}})},
    )
    rec(
        "err_register_builtin",
        error={"code": c.code_of("POST", f"{base}/register-function", {"metadata": {**meta, "canonicalName": "SUM"}, "implHandle": "2"})},
    )

    # post-close: DELETE the session (close + drop) then a command -> the closed-session
    # error. NOTE: the service DELETE both closes AND removes, so the follow-up is
    # `session_not_found` (404) where the in-process rows get `invalid_state`; this single
    # code is masked by parity_matrix.py for the err_post_close step (documented there).
    c.call("DELETE", base)
    rec("err_post_close", error={"code": c.code_of("POST", f"{base}/cell", {"sheet": sh, "row": 0, "col": 0})})

    return out


def main():
    binary = _resolve_binary()
    proc, port = _launch_ready(binary)
    try:
        transcript = run(Client(port))
        json.dump(transcript, sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")
    finally:
        _terminate(proc)


if __name__ == "__main__":
    main()
