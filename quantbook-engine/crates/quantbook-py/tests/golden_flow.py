#!/usr/bin/env python3
"""Phase 6.3-4 — the Python (pyo3) row of the golden parity matrix.

Runs the canonical golden flow (entry-plan 6.3 §6) through the pyo3 `Session`
facade and emits a CANONICAL JSON transcript (an ordered list of step records) to
stdout. The companion `golden_flow.mjs` runs the SAME flow through the napi
`Session`; `parity_matrix.py` runs both and asserts the transcripts match
(masking engine-internal opaque ids / version tokens). The contract is frozen
only once both rows agree (entry-plan §6: "the harness adds a binding by adding a
row").

Loads the compiled extension by PATH (the raw-cdylib pattern, mirroring how
`smoke_session.mjs` `process.dlopen`s the napi cdylib) -- no maturin needed,
because pyo3's `extension-module` feature means the cdylib does not link
libpython. Build first on the Mac host:

    cargo build -p quantbook-py          # debug (has the panic probe)
    python3.12 crates/quantbook-py/tests/golden_flow.py

Override the cdylib path with QL_PY_CDYLIB=/abs/path/to/libquantbook_py.{dylib,so}.
"""

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path


# --- Load the compiled `_quantbook` extension by path (no maturin) ------------

def _resolve_cdylib() -> Path:
    env = os.environ.get("QL_PY_CDYLIB")
    if env:
        p = Path(env)
        if not p.exists():
            raise SystemExit(f"QL_PY_CDYLIB does not exist: {p}")
        return p
    here = Path(__file__).resolve()
    # crates/quantbook-py/tests -> ../../.. = the cargo workspace root.
    workspace_root = here.parents[3]
    ext = "dylib" if sys.platform == "darwin" else "so"
    base = f"libquantbook_py.{ext}"
    # Prefer debug (it carries the __force_panic_for_test probe), then release.
    candidates = [
        workspace_root / "target" / "debug" / base,
        workspace_root / "target" / "release" / base,
    ]
    for c in candidates:
        if c.exists():
            return c
    raise SystemExit(
        "built cdylib not found. Run `cargo build -p quantbook-py` first.\n"
        "Looked in:\n  " + "\n  ".join(str(c) for c in candidates)
    )


def _load_quantbook():
    """Stage the cdylib as `_quantbook.so` on sys.path and import it.

    CPython loads extension modules with the `.so` suffix (even on macOS), so a
    raw `libquantbook_py.dylib` must be copied/renamed before import. We stage
    into a tempdir to keep the source tree clean (no built artifact committed
    under `python/quantbook/`)."""
    cdylib = _resolve_cdylib()
    staging = Path(tempfile.mkdtemp(prefix="qbpy_golden_"))
    target = staging / "_quantbook.so"
    shutil.copy2(cdylib, target)
    sys.path.insert(0, str(staging))
    import _quantbook  # noqa: E402  (path set up above)
    return _quantbook


# --- The canonical golden flow ------------------------------------------------

def _err_code(e) -> str:
    """Recover the engine code from a Python QuantbookError (native `.code`)."""
    code = getattr(e, "code", None)
    if isinstance(code, str):
        return code
    # Fall back to a `[code]` prefix in the message (parity with the napi
    # dual-read), though the pyo3 facade always sets a native `.code`.
    msg = str(e)
    if msg.startswith("["):
        end = msg.find("]")
        if end > 0:
            return msg[1:end]
    return "<no-code>"


def run(qb) -> list:
    Session = qb.Session
    QuantbookError = qb.QuantbookError
    out = []

    def rec(step, **kw):
        out.append({"step": step, **kw})

    def expect_err(step, fn):
        try:
            fn()
            out.append({"step": step, "error": "<did-not-throw>"})
        except QuantbookError as e:  # noqa: PERF203
            out.append({"step": step, "error": {"code": _err_code(e)}})

    s = Session()
    rec("lifecycle_initial", value=s.lifecycle_state())

    # --- new sheet + edits ---
    sh = s.add_sheet("Sheet1", 1000)
    rec("add_sheet", value=sh)
    s.set_value(sh, 0, 0, {"kind": "number", "number": 10.0})  # A1 = 10
    s.set_formula(sh, 0, 1, "A1+1")  # B1 = A1+1
    rec("recalc", value="<opid>" if s.recalc_dirty() is not None else None)
    rec("b1_value", value=s.cell(sh, 0, 1)["value"])

    # --- snapshot ---
    snap = s.snapshot()
    rec("snapshot", sheets=len(snap["sheets"]), schemaVersion=snap["schemaVersion"])

    # --- snapshot_delta: incremental (set_value does NOT bump the epoch) ---
    v_before = s.snapshot()["version"]
    s.set_value(sh, 5, 5, {"kind": "number", "number": 77.0})  # F6 = 77
    s.recalc_dirty()
    delta = s.snapshot_delta(v_before)
    hit = next(
        (c for c in delta["changedCells"] if c["sheet"] == sh and c["cell"]["row"] == 5 and c["cell"]["col"] == 5),
        None,
    )
    # Audit MED-1: pin schemaVersion + the changed-cell coordinate (not just the
    # value) so the delta-surface DTO is cross-checked, not only its presence.
    rec(
        "delta_after_edit",
        fullRebuildRequired=delta["fullRebuildRequired"],
        schemaVersion=delta["schemaVersion"],
        hitCoord=([hit["cell"]["row"], hit["cell"]["col"]] if hit else None),
        changedHit=(hit["cell"]["value"] if hit else None),
    )

    # --- snapshot_delta: empty token -> full rebuild (not an error) ---
    fr = s.snapshot_delta(b"")
    rec("delta_empty_token", fullRebuildRequired=fr["fullRebuildRequired"], reason=fr.get("fullRebuildReason"))

    # --- table (observed via a structured-reference formula) ---
    ts = s.add_sheet("TblSheet", 1000)
    s.set_value(ts, 0, 0, {"kind": "text", "text": "Qty"})  # header A1
    s.set_value(ts, 1, 0, {"kind": "number", "number": 10.0})  # A2
    s.set_value(ts, 2, 0, {"kind": "number", "number": 20.0})  # A3
    s.create_table(
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
        }
    )
    s.set_formula(ts, 0, 2, "SUM(Sales[Qty])")  # C1 on TblSheet
    s.recalc_dirty()
    rec("table_sum", value=s.cell(ts, 0, 2)["value"])

    # --- batch (atomic, observable) ---
    res = s.batch(
        [
            {"kind": "setValue", "sheet": sh, "row": 0, "col": 2, "value": {"kind": "number", "number": 5.0}},  # C1=5
            {"kind": "setFormula", "sheet": sh, "row": 0, "col": 3, "text": "C1*2"},  # D1=C1*2
            # setFormat op (builtin 0 = General) -- exercises the format_id input
            # converter cross-binding; applied becomes 3.
            {"kind": "setFormat", "sheet": sh, "row": 0, "col": 4, "format": {"kind": "builtin", "builtin": 0}},
        ],
        {},
    )
    s.recalc_dirty()
    rec("batch_applied", value=res["applied"])
    rec("batch_d1", value=s.cell(sh, 0, 3)["value"])

    # --- undo / redo (observable) ---
    rec("can_undo_before", value=s.can_undo())
    u = s.undo()
    s.recalc_dirty()
    rec("undo", consumed=u["consumed"], c1=s.cell(sh, 0, 2))  # C1 reverted -> None
    r = s.redo()
    s.recalc_dirty()
    rec("redo", consumed=r["consumed"], c1=(s.cell(sh, 0, 2)["value"] if s.cell(sh, 0, 2) else None))

    # --- persistence: save -> open in a fresh session -> value survives ---
    save_dir = Path(tempfile.mkdtemp(prefix="qbpy_golden_save_"))
    save_path = str(save_dir / "golden.qbook")
    s.save(save_path)
    s2 = Session()
    s2.open(save_path)
    s2.recalc_dirty()
    rec("persist_a1", value=s2.cell(sh, 0, 0)["value"])  # A1 == 10 survives

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
    s.register_function(meta, 1)
    fns = s.list_functions()
    rec("register_udf", present=any(f["canonicalName"] == "MYUDF" for f in fns), total=len(fns))

    # --- events: poll from cursor 0 (>=1 event after the recalcs) ---
    # Audit MED-2: pin the SORTED-UNIQUE event kinds (order-independent) so the
    # event tagged-union DTO mapping is cross-checked, not only the count.
    page = s.poll_events(0)
    rec(
        "poll_events",
        count=len(page["events"]),
        dropped=page["dropped"],
        kinds=sorted({e["kind"] for e in page["events"]}),
    )

    # --- deliberate panic on a SEPARATE session: surfaces, does NOT abort ---
    p = Session()
    fn = getattr(p, "__force_panic_for_test", None) or getattr(p, "_Session__force_panic_for_test", None)
    if fn is not None:
        try:
            fn()
            rec("panic", error="<did-not-throw>")
        except QuantbookError as e:
            rec("panic", error={"code": _err_code(e)})
        # Host still alive (we got here); session still answers a pure read.
        rec("after_panic_lifecycle", value=p.lifecycle_state())
    else:
        rec("panic", error={"code": "panic"}, note="probe-absent-release")
        rec("after_panic_lifecycle", value=p.lifecycle_state())

    # --- error-path rows (stable codes) ---
    expect_err("err_dup_sheet", lambda: s.add_sheet("Sheet1", 1000))
    expect_err("err_bad_kind", lambda: s.set_value(sh, 9, 9, {"kind": "bogus"}))
    expect_err("err_register_builtin", lambda: s.register_function({**meta, "canonicalName": "SUM"}, 2))

    # post-close: a command on a Closed session -> invalid_state (do this LAST)
    s.close()
    expect_err("err_post_close", lambda: s.cell(sh, 0, 0))

    return out


def main():
    qb = _load_quantbook()
    transcript = run(qb)
    json.dump(transcript, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
