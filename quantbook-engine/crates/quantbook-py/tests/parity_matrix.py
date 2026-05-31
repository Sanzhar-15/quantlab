#!/usr/bin/env python3
"""Phase 6.3-4 — the golden cross-binding PARITY MATRIX (the 6.3 exit gate).

Runs the canonical golden flow through BOTH binding rows and asserts the
transcripts are byte-identical after masking engine-internal opaque values
(operation ids, version tokens, event cursors). This is what proves the contract
cannot fork across bindings (entry-plan 6.3 §6 / decision-lock §5 risk #1): a
Node-only matrix proves self-consistency; ONLY a second, structurally-different
row (the pyo3 facade) proves cross-binding parity.

    cargo build -p quantbook-py
    cargo build -p ql-bindings-node
    python3.12 crates/quantbook-py/tests/parity_matrix.py

Env overrides: QL_PY_CDYLIB, QL_NODE_CDYLIB (passed through to the emitters),
QL_NODE for the node binary (default "node"), QL_PY for the python binary
(default this interpreter).

Masking (user decision): opaque ids / version tokens legitimately differ in VALUE
across bindings (engine-internal counters) without being a parity defect, so they
are normalized to a placeholder before comparison; DTO structure + keys + error
codes are compared verbatim. The masking is intentionally NARROW (named keys
only) so it cannot hide a real divergence.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NODE_EMITTER = HERE.parents[1] / "ql-bindings-node" / "tests" / "golden_flow.mjs"
PY_EMITTER = HERE / "golden_flow.py"

# Dict keys whose VALUES are engine-internal opaque tokens (mask their value).
# `version` = the opaque SessionVersion bytes; `nextCursor` = the event-ring
# cursor. Everything else (incl. error codes, schemaVersion, applied, consumed,
# fullRebuildRequired, the cell values) is a genuine cross-binding signal and is
# compared verbatim.
MASK_KEYS = {"version", "nextCursor"}

# MED-3 (6.3-5): the EXACT ordered step-name list both golden flows emit. The
# anti-vacuity guard asserts each transcript's `step` sequence equals this list
# VERBATIM (not just len >= N) so a silently-truncated, reordered, or renamed
# emitter cannot slip a vacuous pass. Derived from `golden_flow.py`'s `rec(...)`/
# `expect_err(...)` calls in order. Includes the HIGH-A `recalc_op_id` witness
# (step 3) added in 6.3-5 -> 23 steps (was 22).
EXPECTED_STEPS = [
    "lifecycle_initial",
    "add_sheet",
    "recalc_op_id",
    "recalc",
    "b1_value",
    "snapshot",
    "delta_after_edit",
    "delta_empty_token",
    "table_sum",
    "batch_applied",
    "batch_d1",
    "can_undo_before",
    "undo",
    "redo",
    "persist_a1",
    "register_udf",
    "poll_events",
    "panic",
    "after_panic_lifecycle",
    "err_dup_sheet",
    "err_bad_kind",
    "err_register_builtin",
    "err_post_close",
]


def mask(node):
    """Recursively normalize a parsed transcript: blank out opaque token values."""
    if isinstance(node, list):
        return [mask(x) for x in node]
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k in MASK_KEYS:
                out[k] = "<masked>"
            else:
                out[k] = mask(v)
        return out
    return node


def run_emitter(argv, label):
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=300)
    except FileNotFoundError as e:
        raise SystemExit(f"{label}: cannot launch {argv[0]!r}: {e}")
    if proc.returncode != 0:
        sys.stderr.write(f"--- {label} STDERR ---\n{proc.stderr}\n")
        raise SystemExit(f"{label}: emitter exited {proc.returncode}")
    line = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"--- {label} STDOUT ---\n{proc.stdout}\n")
        raise SystemExit(f"{label}: transcript is not valid JSON: {e}")
    # MED-3 (6.3-5): guard against a vacuous/truncated/reordered pass by asserting
    # the EXACT ordered step-name list (not just a length floor). A silently-broken
    # emitter that drops, renames, or reorders steps now fails loud here.
    if not isinstance(parsed, list):
        sys.stderr.write(f"--- {label} STDOUT ---\n{proc.stdout}\n")
        raise SystemExit(f"{label}: transcript is not a list -- refusing a vacuous pass")
    actual_steps = [row.get("step") if isinstance(row, dict) else None for row in parsed]
    if actual_steps != EXPECTED_STEPS:
        sys.stderr.write(f"--- {label} STDOUT ---\n{proc.stdout}\n")
        sys.stderr.write(f"expected steps: {EXPECTED_STEPS}\n")
        sys.stderr.write(f"actual steps:   {actual_steps}\n")
        raise SystemExit(
            f"{label}: step list does not match the canonical {len(EXPECTED_STEPS)}-step flow "
            f"({len(actual_steps)} steps) -- refusing a vacuous/divergent pass"
        )
    return parsed


def diff(a, b):
    """First differing step (by index), for a readable failure."""
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return i, x, y
    if len(a) != len(b):
        return min(len(a), len(b)), (a[len(b):] or None), (b[len(a):] or None)
    return None


def main():
    node_bin = os.environ.get("QL_NODE", "node")
    py_bin = os.environ.get("QL_PY", sys.executable)

    node_t = mask(run_emitter([node_bin, str(NODE_EMITTER)], "node"))
    py_t = mask(run_emitter([py_bin, str(PY_EMITTER)], "python"))

    if node_t == py_t:
        print(f"PARITY OK ({len(node_t)} steps matched across Node + Python rows)")
        return 0

    d = diff(node_t, py_t)
    sys.stderr.write("PARITY MISMATCH\n")
    if d is not None:
        i, x, y = d
        sys.stderr.write(f"first divergence at step index {i}:\n")
        sys.stderr.write(f"  node:   {json.dumps(x, sort_keys=True)}\n")
        sys.stderr.write(f"  python: {json.dumps(y, sort_keys=True)}\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
