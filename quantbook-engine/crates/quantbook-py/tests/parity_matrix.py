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
# 6.2-4: the third row -- the ql-service HTTP transport (launches the debug binary).
SERVICE_EMITTER = HERE / "golden_flow_service.py"

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


# The `err_post_close` code legitimately differs by TRANSPORT: the in-process rows
# (napi/pyo3) call close() then hit a still-present CLOSED session -> `invalid_state`;
# the service DELETE both closes AND removes the session, so the follow-up command gets
# `session_not_found`. (Verified empirically 2026-06-01.) There is no close-without-remove
# route, so this is a real transport difference, not a defect.
CLOSED_SESSION_CODES = {
    "node": {"invalid_state"},
    "python": {"invalid_state"},
    "service": {"session_not_found"},
}


def normalize_closed_session(transcript, label):
    """ASSERT the err_post_close code is the expected closed-session code for this
    transport, THEN normalize it to a placeholder so the cross-row compare ignores the
    (legitimate) per-transport value. This keeps the "fails loud with the RIGHT code"
    proof the step is named for -- a regression to a wrong/absent code fails here -- while
    still allowing the transports to differ. Only this ONE code value is touched."""
    expected = CLOSED_SESSION_CODES[label]
    for row in transcript:
        if isinstance(row, dict) and row.get("step") == "err_post_close":
            err = row.get("error")
            if not (isinstance(err, dict) and isinstance(err.get("code"), str)):
                raise SystemExit(f"{label}: err_post_close has no error code -- must fail loud")
            if err["code"] not in expected:
                raise SystemExit(
                    f"{label}: err_post_close code {err['code']!r} not in expected {sorted(expected)} "
                    f"-- a command after close must fail with the closed-session code"
                )
            err["code"] = "<closed-session>"
    return transcript


def canonical(transcript):
    """Compact, key-sorted JSON. Unlike `==`, this PRESERVES int-vs-float (`6` != `6.0`),
    so it is the byte-identical gate for the service-vs-node number rendering."""
    return json.dumps(transcript, sort_keys=True, separators=(",", ":"))


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
    # The pyo3 cdylib is abi3-py310; running the matrix under an older interpreter would
    # mis-load (or subtly mis-behave) the Python row. Fail loud rather than silently use a
    # wrong interpreter (the host default `python3` is 3.9; run with python3.12+).
    if sys.version_info < (3, 10):
        raise SystemExit(
            f"parity_matrix requires Python >= 3.10 (pyo3 abi3-py310); got {sys.version.split()[0]}"
        )

    node_bin = os.environ.get("QL_NODE", "node")
    py_bin = os.environ.get("QL_PY", sys.executable)

    def prep(argv, label):
        # mask opaque tokens, then assert+normalize the transport-specific closed-session code.
        return normalize_closed_session(mask(run_emitter(argv, label)), label)

    node_t = prep([node_bin, str(NODE_EMITTER)], "node")
    py_t = prep([py_bin, str(PY_EMITTER)], "python")
    service_t = prep([py_bin, str(SERVICE_EMITTER)], "service")

    # 1. STRUCTURAL parity across all three rows (Node + pyo3 + service). `==` is
    #    int/float-tolerant (`6 == 6.0`); this is the cross-binding contract gate.
    for label, t in (("python", py_t), ("service", service_t)):
        if node_t != t:
            d = diff(node_t, t)
            sys.stderr.write(f"PARITY MISMATCH (node vs {label})\n")
            if d is not None:
                i, x, y = d
                sys.stderr.write(f"first divergence at step index {i}:\n")
                sys.stderr.write(f"  node:    {json.dumps(x, sort_keys=True)}\n")
                sys.stderr.write(f"  {label}: {json.dumps(y, sort_keys=True)}\n")
            return 1

    # 2. BYTE gate (service vs node ONLY): the service wire must be byte-identical to
    #    the napi/Node row INCLUDING number rendering (ECMAScript `6`, not serde `6.0`).
    #    The Python (pyo3) row is EXCLUDED BY DESIGN -- its FROZEN contract emits Python
    #    floats (`6.0`), so it participates only in the structural gate above. This is
    #    what gates the 6.2-4 `ecma_number_string` serializer end-to-end.
    if canonical(node_t) != canonical(service_t):
        sys.stderr.write("BYTE PARITY MISMATCH (service vs node) -- number/format divergence\n")
        d = diff(node_t, service_t)
        if d is not None:
            i, x, y = d
            sys.stderr.write(f"first byte divergence at step index {i}:\n")
            sys.stderr.write(f"  node:    {canonical(x)}\n")
            sys.stderr.write(f"  service: {canonical(y)}\n")
        return 1

    print(
        f"PARITY OK ({len(node_t)} steps matched across Node + Python + Service rows; "
        f"service==node byte-identical)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
