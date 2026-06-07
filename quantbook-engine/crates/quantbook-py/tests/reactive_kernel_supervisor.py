#!/usr/bin/env python3
"""FE-1.5-1c-1 — the SUPERVISOR: bridge the 1c-0 fd-3 stdio protocol to a REAL ipykernel.

FE-1.5-1c-0 proved the out-of-process transport with an EMBEDDED-IPython child over fd 3.
FE-1.5-1c-0.5 proved a REAL ipykernel can be spawned + hook-injected + driven (jupyter_client +
a Jupyter Comm) with NO Node native dep. FE-1.5-1c-1 JOINS them: this supervisor is a drop-in
replacement for the 1c-0 child -- it speaks the SAME fd-3 protocol to the Node host, but instead
of running cells in-process it drives a REAL ipykernel over ZMQ (jupyter_client) and relays the
kernel's Comm republish frames back to the host. So the host barely changes; the moat now runs
end-to-end through a real kernel:

  Node host (owns napi Session + cursor)
       |  stdin: {execute|epoch_change|close}        ^ fd 3: {ready|republish|stale|executed|error|closed}
       v                                             |  fd 1: forwarded cell stdout (the print plane)
  THIS supervisor (jupyter_client)
       |  shell: execute_request                     ^ iopub: comm_msg (republish) / stream / error
       v                                             |
  REAL ipykernel (kernelspec `fe15`) running the SAME Quantbook glue (reactive_kernel_child.py),
  emit=Comm.send -> the qb_republish Comm. The kernel-side glue is UNCHANGED from 1c-0 (the emit
  sink is injectable); the Comm payload is the identical {type,name,values,target,overwrite} frame.

Two planes, never multiplexed (as in 1c-0): the kernel's Comm `comm_msg` is the control/republish
plane (relayed to fd 3); a cell's `print()` is iopub `stream` stdout (forwarded to fd 1).

Fail-loud (No-Fallbacks): a CELL-body error surfaces as an iopub `error`; a HOOK error surfaces
as a Comm `{type:error}` frame (the bootstrap wrapper emits it -- IPython would otherwise SWALLOW
a post_run_cell callback exception). Either becomes the cell's terminal `{type:error}` to the host.

Run: spawned by the Node host (`reactive_kernel_host_real.mjs`), which sets QL_KERNEL_PYTHON and
spawns `python -u <this>`. Standalone it needs the `fe15` kernelspec + ipykernel/jupyter_client.
"""

import atexit
import json
import os
import queue
import signal
import sys
from pathlib import Path

from jupyter_client.manager import KernelManager

_HERE = Path(__file__).resolve()
_TESTS_DIR = _HERE.parent  # holds reactive_kernel_child.py (the shared Quantbook glue)
_KERNEL_NAME = "fe15"
_COMM_TARGET = "qb_republish"
_IOPUB_TIMEOUT = 30
_CTRL_FD = 3  # the control/republish plane to the HOST (matches the 1c-0 child)

# Inject into the REAL kernel (silent execute). Reuses the SAME Quantbook glue as 1c-0 verbatim
# (reactive_kernel_child.Quantbook), only swapping the emit sink to a Jupyter Comm. The hook
# wrapper re-emits a hook error over the Comm because IPython SWALLOWS post_run_cell exceptions.
_BOOTSTRAP = r'''
import sys as _sys
if r"{TESTS_DIR}" not in _sys.path:
    _sys.path.insert(0, r"{TESTS_DIR}")
from reactive_kernel_child import Quantbook as _QB
from comm import create_comm as _qb_create_comm   # ipykernel.comm.Comm is deprecated -> the `comm` pkg

import os as _qb_os
_qb_comm = _qb_create_comm(target_name="{COMM_TARGET}", data={{"proto": "fe15-1c1"}})
qb = _QB(get_ipython(), emit=lambda frame: _qb_comm.send(frame))

def _qb_hook(result):
    # IPython SWALLOWS a raising post_run_cell callback -> a silent missed republish. Re-emit the
    # error over the Comm (the supervisor turns it into a FATAL cell error). If the Comm itself --
    # the only structured error channel back to the host -- is dead, do NOT let the error vanish:
    # kill the kernel HARD so the host sees a FATAL exit (No-Fallbacks; no stale-sentinel games).
    try:
        qb.on_post_run_cell(result)
    except BaseException as _e:
        try:
            _qb_comm.send({{"type": "error", "error": repr(_e)}})
        except BaseException:
            _qb_os._exit(70)   # error channel dead -> loud kernel death, never a swallowed hook error
        raise                  # re-raise for the IPython log

get_ipython().events.register("post_run_cell", _qb_hook)

def _qb_epoch():
    qb.on_epoch_change()   # R7: the host signals an undo/redo epoch -> mark every binding force_check
'''


def _log(msg):
    print(f"[supervisor 1c-1] {msg}", file=sys.stderr, flush=True)


def _emit(obj):
    """One NDJSON frame to the HOST on fd 3 (loop until fully written; loud on a closed pipe)."""
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


# HIGH Codex fold: a last-resort teardown net. Every KernelManager is registered the instant it
# is created (BEFORE start_kernel), so even if a SIGTERM->SystemExit interrupts construction --
# before `sup` is assigned in main() -- atexit still tears the spawned ipykernel down. Idempotent
# with the normal shutdown (has_kernel guard); covers EVERY failure path, not just steady state.
_ACTIVE_KMS = []


def _cleanup_kms():
    for km in _ACTIVE_KMS:
        try:
            if km.has_kernel:
                km.shutdown_kernel(now=True)
        except Exception as exc:  # teardown net -- log, never silently swallow
            print(f"[supervisor 1c-1] atexit kernel cleanup error: {exc!r}", file=sys.stderr, flush=True)


atexit.register(_cleanup_kms)


class Supervisor:
    def __init__(self):
        self.km = KernelManager(kernel_name=_KERNEL_NAME)
        _ACTIVE_KMS.append(self.km)   # register BEFORE start_kernel so the atexit net always covers it
        self.kc = None
        self.comm_id = None
        try:
            self.km.start_kernel()
            self.kc = self.km.client()
            self.kc.start_channels()
            self.kc.wait_for_ready(timeout=60)
            self._inject_bootstrap()
        except BaseException:
            self.shutdown()
            raise

    def _inject_bootstrap(self):
        boot = _BOOTSTRAP.format(TESTS_DIR=str(_TESTS_DIR), COMM_TARGET=_COMM_TARGET)
        err = self._drain(self.kc.execute(boot, silent=True, store_history=False))
        if err is not None:
            raise SystemExit(f"bootstrap injection failed in the kernel: {err}")
        if self.comm_id is None:
            raise SystemExit("bootstrap did not open the qb_republish comm (no comm_open captured)")

    def _drain(self, msg_id):
        """Drain iopub to idle for `msg_id`. Relays republish/stale Comm frames to the host fd 3
        AS THEY ARRIVE; forwards cell stdout to fd 1; collects a cell error (iopub error OR a
        hook Comm error) and RETURNS it (so the caller sends exactly one terminal frame)."""
        cell_error = None
        while True:
            try:
                msg = self.kc.get_iopub_msg(timeout=_IOPUB_TIMEOUT)
            except queue.Empty:
                raise SystemExit(f"iopub timeout draining msg_id={msg_id}")
            if msg["parent_header"].get("msg_id") != msg_id:
                continue
            t = msg["msg_type"]
            c = msg["content"]
            if t == "comm_open":
                if c.get("target_name") == _COMM_TARGET:
                    self.comm_id = c["comm_id"]
            elif t == "comm_msg":
                if self.comm_id is None or c.get("comm_id") != self.comm_id:
                    raise SystemExit(f"comm_msg on an unexpected comm_id {c.get('comm_id')!r}")
                data = c["data"]
                kind = data.get("type")
                if kind in ("republish", "stale"):
                    _emit(data)  # relay verbatim -> the host applies it (frame schema == 1c-0)
                elif kind == "error":
                    cell_error = data.get("error")  # a HOOK error; terminal, not relayed inline
                else:
                    raise SystemExit(f"unknown comm frame type from kernel: {kind!r}")
            elif t == "stream" and c.get("name") == "stdout":
                os.write(1, c["text"].encode("utf-8"))   # the cell-output plane (fd 1)
            elif t == "stream" and c.get("name") == "stderr":
                os.write(2, c["text"].encode("utf-8"))   # kernel diagnostics
            elif t == "error":
                cell_error = f"{c.get('ename')}: {c.get('evalue')}"  # a CELL-body error
            elif t == "status" and c.get("execution_state") == "idle":
                break
        return cell_error

    def execute(self, code):
        err = self._drain(self.kc.execute(code, silent=False, store_history=True))
        _emit({"type": "error", "error": err} if err is not None else {"type": "executed", "ok": True})

    def epoch_change(self):
        # R7: mark force_check on every binding; no republish expected (force_check only marks).
        err = self._drain(self.kc.execute("_qb_epoch()", silent=True, store_history=False))
        _emit({"type": "error", "error": err} if err is not None else {"type": "epoch_done"})

    def unpublish(self, name):
        # MED Codex fold: roll back a ghost binding the host refused (G3). Reverse control message.
        err = self._drain(self.kc.execute(f"qb.unpublish({name!r})", silent=True, store_history=False))
        _emit({"type": "error", "error": err} if err is not None else {"type": "unpublished"})

    def shutdown(self):
        try:
            if self.kc is not None:
                self.kc.stop_channels()
        finally:
            if self.km.has_kernel:   # guard: partial construction may leave no kernel to shut down
                self.km.shutdown_kernel(now=True)


def main():
    sup = None
    # HIGH Codex fold: a SIGTERM/SIGINT (the host's graceful kill) must run the `finally` so the
    # real ipykernel is torn down (shutdown_kernel) -- NOT be left orphaned. Convert the signal
    # into a SystemExit so the try/finally below tears the kernel down.
    def _on_signal(signum, _frame):
        raise SystemExit(f"supervisor received signal {signum}")
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    try:
        sup = Supervisor()
        _emit({"type": "ready"})
        while True:
            line = sys.stdin.readline()
            if line == "":
                return  # host closed stdin
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                _emit({"type": "error", "error": f"malformed host frame: {exc}"})
                continue
            op = req.get("type")
            if op == "execute":
                sup.execute(req["code"])
            elif op == "epoch_change":
                sup.epoch_change()
            elif op == "unpublish":
                sup.unpublish(req["name"])
            elif op == "close":
                _emit({"type": "closed"})
                return
            else:
                _emit({"type": "error", "error": f"unknown supervisor op: {op!r}"})
    finally:
        if sup is not None:
            sup.shutdown()


if __name__ == "__main__":
    main()
