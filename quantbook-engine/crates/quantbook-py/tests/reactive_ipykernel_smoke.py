#!/usr/bin/env python3
"""FE-1.5-1c-0.5 — REAL-ipykernel smoke: retire the native-dep + hook-injection unknowns.

FE-1.5-1c-0 proved the out-of-process reactive TRANSPORT, but its kernel child was an EMBEDDED
IPython shell reading our own stdin protocol over a hand-rolled fd-3 side channel. The shipped
notebook UI + acid#4 (debugpy attach) need a REAL `ipykernel` driven over the Jupyter ZMQ wire
protocol -- a DIFFERENT kernel (different spawn model, hook-injection path, lifecycle, AND a
`zeromq` native dep the quantlab extension does NOT have). The w46 megaudit (plan §12.2) pulled
this smoke EARLY -- before 1d -- so the native-dep/packaging surprise is retired now, not late.

This smoke proves, against a REAL ipykernel, the three things 1c-0's embedded shell did NOT:

  1. SPAWN + DRIVE a real ipykernel with NO Node native dep. We drive it from a Python
     `jupyter_client` SUPERVISOR over ZMQ. In the shipped topology the Node host would talk to
     THIS supervisor over stdio (the 1c-0 bridge) and the supervisor talks to the kernel over
     ZMQ -- so the Node extension never imports `zeromq`. (The Node-native `zeromq.js` path is a
     real alternative; `reactive_ipykernel_zeromq_probe.mjs` costs its availability. The DECISION
     is recorded in plan §11.2/§11.3. This smoke proves the no-Node-native-dep path WORKS.)

  2. HOOK INJECTION into a running kernel. 1c-0 registered `post_run_cell` in-process at startup;
     here we inject it via a SILENT `execute_request` after the kernel is live (donor pattern:
     `.references/vscode-jupyter/.../addRunCellHook.py`; we use the cleaner
     `get_ipython().events.register('post_run_cell', ...)` form, per plan §11.3). The injected
     glue reuses the 1c-0 DETECTOR HELPERS verbatim (`cell_defs_refs` + `_fingerprint` +
     `_to_matrix` imported from `reactive_kernel_child`), so the SAME change-detection runs in a
     real kernel; the registry + hook wrapper around them is a minimal re-impl (it emits over the
     comm, not fd 3 -- the host-wiring is 1c-1).

  3. A REAL dedicated SIDE-CHANNEL out of the kernel: a Jupyter COMM (`ipykernel.comm.Comm`),
     the ZMQ-world analog of 1c-0's fd 3. The hook sends republish frames as `comm_msg` on
     iopub; a cell's `print()` lands on the iopub `stream` plane -- the planes stay SEPARATE,
     exactly as fd1-vs-fd3 in 1c-0. (Comm is also the forward-compatible channel for the
     notebook UI + acid#4.)

SCOPE: this is the KERNEL-MECHANISM smoke. It asserts the republish PAYLOAD the host would
apply (name / values-matrix / target) arrives on the comm -- it does NOT touch the napi Session
(the engine path is already proven end-to-end in 1c-0). Wiring the real kernel to the napi host
is 1c-1.

Assertions (fail-loud, No-Fallbacks):
  - bootstrap injects cleanly (no kernel error) and opens the `qb_republish` comm;
  - register x=0           -> ONE comm republish {x, [[0]], "Bench!B1"}; the same-cell hook QUIET;
  - x = 7                  -> hook fires in the REAL kernel -> comm republish {x, [[7]], ...};
  - y = 99 (unrelated)     -> NO comm republish (engine-quiet across the real kernel);
  - vec=[10,20,30]; vec[1]=99 -> mutate-in-place detected -> comm republish {vec, [[10,99,30]]};
  - print("MARKER")        -> the MARKER lands on the iopub stdout STREAM, NOT on the comm
                              (channel separation in the ZMQ world);
  - a cell that RAISES     -> surfaced as an iopub `error` (fail-loud, not swallowed).

Run (Mac host):
  export QL_KERNEL_PYTHON=$HOME/.fe15-spike-venv/bin/python3.12   # has ipykernel/jupyter_client/pyzmq
  $QL_KERNEL_PYTHON crates/quantbook-py/tests/reactive_ipykernel_smoke.py
Needs the `fe15` kernelspec (registered via `python -m ipykernel install --sys-prefix --name fe15`).
"""

import queue
from pathlib import Path

from jupyter_client.manager import KernelManager

_HERE = Path(__file__).resolve()
_TESTS_DIR = _HERE.parent  # crates/quantbook-py/tests -- holds reactive_kernel_child.py
_KERNEL_NAME = "fe15"
_IOPUB_TIMEOUT = 30
_COMM_TARGET = "qb_republish"

# Injected into the REAL kernel via a silent execute_request. Reuses the 1c-0 detector HELPERS
# verbatim (cell_defs_refs/_fingerprint/_to_matrix imported from reactive_kernel_child); the
# registry + hook around them is a minimal re-impl that emits over the comm (not fd 3).
# {TESTS_DIR} is interpolated by the supervisor (the kernel cwd is not this dir).
_BOOTSTRAP = r'''
import sys as _sys
if r"{TESTS_DIR}" not in _sys.path:
    _sys.path.insert(0, r"{TESTS_DIR}")
from reactive_kernel_child import (
    cell_defs_refs as _qb_defs_refs,
    _fingerprint as _qb_fp,
    _to_matrix as _qb_matrix,
)
from ipykernel.comm import Comm as _QbComm

_qb_reg = {{}}                       # name -> {{"target":..., "fp":...}}
_qb_sent = object()
# Open the dedicated republish side-channel NOW (a comm_open the supervisor captures at bootstrap).
_qb_comm = _QbComm(target_name="{COMM_TARGET}", data={{"proto": "fe15-1c0.5"}})

def _qb_send(name, value):
    _qb_comm.send({{"name": name, "values": _qb_matrix(value), "target": _qb_reg[name]["target"]}})

def _qb_register(name, value, target):
    _qb_reg[name] = {{"target": target, "fp": _qb_fp(value)}}
    _qb_send(name, value)            # initial write frame (the same-cell hook then stays quiet)

def _qb_on_post_run_cell(result):
    src = result.info.raw_cell if getattr(result, "info", None) is not None else ""
    try:
        defs, refs = _qb_defs_refs(src)
    except SyntaxError:
        return                        # magics / non-python cells: out of scope (documented 1b limit)
    ip = get_ipython()
    for name in sorted((defs | refs) & set(_qb_reg)):
        cur = ip.user_ns.get(name, _qb_sent)
        if cur is _qb_sent:
            continue                  # del'd var: stale-handling is 1c-0's concern, not this smoke
        fp = _qb_fp(cur)
        if fp != _qb_reg[name]["fp"]:
            _qb_reg[name]["fp"] = fp
            _qb_send(name, cur)

get_ipython().events.register("post_run_cell", _qb_on_post_run_cell)
'''


def _fail(msg):
    raise SystemExit(f"[reactive-ipykernel-smoke 1c-0.5] FAIL: {msg}")


class Supervisor:
    """A jupyter_client supervisor: spawns the REAL ipykernel and drives it over ZMQ. Collects,
    per executed cell, the comm republish payloads + the stdout stream + any error."""

    def __init__(self):
        self.km = KernelManager(kernel_name=_KERNEL_NAME)
        self.kc = None
        self.comm_id = None  # learned from the bootstrap comm_open
        self.km.start_kernel()
        # MED-2 (1c-0.5 Codex fold): once the kernel is spawned, ANY later construction failure
        # (client/start_channels) must still tear the kernel down -- never leak the process.
        try:
            self.kc = self.km.client()
            self.kc.start_channels()
        except BaseException:
            self.shutdown()
            raise

    def wait_ready(self):
        self.kc.wait_for_ready(timeout=60)

    def run(self, code, *, silent=False):
        """Execute one cell; drain iopub to idle. Returns (republishes, stdout, error)."""
        msg_id = self.kc.execute(code, silent=silent, store_history=not silent)
        republishes, stdout, error = [], [], None
        while True:
            try:
                msg = self.kc.get_iopub_msg(timeout=_IOPUB_TIMEOUT)
            except queue.Empty:
                _fail(f"iopub timeout draining cell: {code!r}")
            if msg["parent_header"].get("msg_id") != msg_id:
                continue  # a stale message from a prior request; ours is strictly correlated
            t = msg["msg_type"]
            content = msg["content"]
            if t == "comm_open":
                if content.get("target_name") == _COMM_TARGET:
                    self.comm_id = content["comm_id"]
            elif t == "comm_msg":
                if self.comm_id is not None and content.get("comm_id") == self.comm_id:
                    republishes.append(content["data"])
                else:
                    _fail(f"comm_msg on an unexpected comm_id {content.get('comm_id')!r}")
            elif t == "stream" and content.get("name") == "stdout":
                stdout.append(content["text"])
            elif t == "error":
                error = content
            elif t == "status" and content.get("execution_state") == "idle":
                break
        return republishes, "".join(stdout), error

    def shutdown(self):
        try:
            if self.kc is not None:
                self.kc.stop_channels()
        finally:
            self.km.shutdown_kernel(now=True)


def _one(republishes, label):
    if len(republishes) != 1:
        _fail(f"{label}: expected exactly 1 comm republish, got {len(republishes)}: {republishes}")
    return republishes[0]


def main():
    sup = None
    try:
        sup = Supervisor()  # MED-2: inside the try so a construction failure still reaches finally
        sup.wait_ready()

        # --- bootstrap: inject the hook + open the comm (silent; we don't want output noise) ---
        boot = _BOOTSTRAP.format(TESTS_DIR=str(_TESTS_DIR), COMM_TARGET=_COMM_TARGET)
        reps, _out, err = sup.run(boot, silent=True)
        if err is not None:
            _fail(f"bootstrap injection raised in the kernel: {err.get('ename')}: {err.get('evalue')}")
        if sup.comm_id is None:
            _fail("bootstrap did not open the qb_republish comm (no comm_open captured)")
        if reps:
            _fail(f"bootstrap must not republish, got {reps}")

        # --- register x=0 -> ONE initial frame; the same-cell hook stays QUIET (no double-fire) ---
        reps, _o, err = sup.run('x = 0\n_qb_register("x", x, "Bench!B1")')
        if err is not None:
            _fail(f"register cell raised: {err.get('ename')}: {err.get('evalue')}")
        f = _one(reps, "register")
        if not (f["name"] == "x" and f["values"] == [[0]] and f["target"] == "Bench!B1"):
            _fail(f"register: wrong frame {f}")

        # --- x = 7 -> the hook fires IN THE REAL KERNEL -> comm republish ---
        reps, _o, err = sup.run("x = 7")
        if err is not None:
            _fail(f"x=7 raised: {err}")
        f = _one(reps, "reassign")
        if not (f["name"] == "x" and f["values"] == [[7]] and f["target"] == "Bench!B1"):
            _fail(f"reassign: wrong frame {f}")

        # --- y = 99 (unrelated) -> NO comm republish (engine-quiet across the real kernel) ---
        reps, _o, err = sup.run("y = 99")
        if err is not None:
            _fail(f"y=99 raised: {err}")
        if reps:
            _fail(f"unrelated cell must be quiet, got {reps}")

        # --- same value x = 7 again -> fingerprint unchanged -> quiet ---
        reps, _o, err = sup.run("x = 7")
        if err is not None:
            _fail(f"same-value x=7 raised: {err}")  # MED-1: a hidden error must not read as 'quiet'
        if reps:
            _fail(f"same-value reassign must be quiet, got {reps}")

        # --- vec mutate-in-place: defs empty, vec a ref, fingerprint changed -> republish ---
        reps, _o, err = sup.run('vec = [10, 20, 30]\n_qb_register("vec", vec, "Bench!A3:C3")')
        if err is not None:
            _fail(f"vec register raised: {err}")
        _one(reps, "vec-register")
        reps, _o, err = sup.run("vec[1] = 99")
        if err is not None:
            _fail(f"vec mutate raised: {err}")
        f = _one(reps, "vec-mutate")
        if not (f["name"] == "vec" and f["values"] == [[10, 99, 30]] and f["target"] == "Bench!A3:C3"):
            _fail(f"vec-mutate: wrong frame {f}")

        # --- channel separation: print() -> iopub STREAM; NOT the comm ---
        reps, out, err = sup.run('print("CELLOUT-MARKER-1C05")\nx = 11')
        if err is not None:
            _fail(f"print cell raised: {err}")
        f = _one(reps, "sep")  # the x=11 reassign republishes once
        if not (f["name"] == "x" and f["values"] == [[11]]):
            _fail(f"sep: wrong republish {f}")
        if "CELLOUT-MARKER-1C05" not in out:
            _fail(f"sep: print() must land on the iopub stdout stream, got {out!r}")

        # --- fail-loud: a raising cell surfaces as an iopub error (not swallowed) ---
        reps, _o, err = sup.run('raise RuntimeError("boom-1c05")')
        if err is None or "boom-1c05" not in (err.get("evalue") or ""):
            _fail(f"a raising cell must surface as an iopub error, got err={err}")
        # the kernel survives a cell error -> the next cell still republishes
        reps, _o, err = sup.run("x = 12")
        if err is not None:
            _fail(f"recover cell raised: {err}")  # MED-1: republish + a hidden error is not 'recovered'
        f = _one(reps, "recover")
        if f["values"] != [[12]]:
            _fail(f"recover: kernel must survive a cell error; expected [[12]], got {f['values']}")

        print("[reactive-ipykernel-smoke 1c-0.5] PASS — REAL ipykernel via jupyter_client (no Node native dep)")
        print("  spawn   real ipykernel (kernelspec fe15) driven over ZMQ by a jupyter_client supervisor")
        print("  inject  post_run_cell hook via a silent execute_request (donor: addRunCellHook.py)")
        print("  channel republish frames over a Jupyter COMM (qb_republish); the ZMQ analog of fd 3")
        print("  register x=0 -> 1 comm frame; same-cell hook QUIET (no double-fire)")
        print("  x=7          -> hook fires in the REAL kernel -> comm republish {x,[[7]],Bench!B1}")
        print("  y=99 / x=7-again -> NO comm frame (engine-quiet across the real kernel)")
        print("  vec[1]=99    -> mutate-in-place detected -> comm republish {vec,[[10,99,30]]}")
        print("  print()      -> iopub stdout STREAM, NOT the comm (channel separation, ZMQ world)")
        print("  raise        -> iopub error (fail-loud); kernel survives -> next cell republishes")
    finally:
        if sup is not None:
            sup.shutdown()


if __name__ == "__main__":
    main()
