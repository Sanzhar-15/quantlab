#!/usr/bin/env python3
"""FE-1.5-1.B — the var->cell BINDING: `qb.publish(name, value, target)` + registry + guards.

FE-1.5-1a proved the post_run_cell -> publish -> reactive-recalc SEAM; FE-1.5-1b built the
def/ref + value-fingerprint change-detector that picks WHICH registered var to republish. Both
HARD-CODED the var->cell mapping (`bridge.register("x", B1, ...)` + a manual `publish_dataset`
seed). The megaudit (plan §12.1) flagged that mapping as the load-bearing UNDESIGNED decision.

FE-1.5-1.B is that design, BUILT (plan §13, Codex-consulted/endorsed):

  `qb.publish("df", df, "Sheet!A1:D100")`  ==>  (a) register name->target in a kernel-memory
  registry, (b) write the values NOW via publish_dataset. After this ONE call, the 1a/1b
  post_run_cell hook AUTO-republishes `df` on any later reassign / mutate-in-place -- that is
  acid #1's "no user action". The NOTEBOOK CODE is the single source of truth: durability comes
  from run-all on reopen (cold values persist in cells because publish writes real cells);
  `.qbook` stores cells, NOT bindings; `bind_range` stays disconnected.

What this spike PROVES (each fail-loud, in-process: embedded IPython + pyo3 Session, zero IPC):

  Reactive flow (the binding actually drives the moat):
    B  x=0;     qb.publish("x", x, "Bench!B1")      -> writes B1=0; the SAME-cell hook is QUIET
                                                        (explicit publish + hook do NOT double-fire)
    C  x=7                                           -> hook auto-republishes x -> C1 (=B1*2) = 14
    D  s.set_value(B1,999) [foreign hand-edit]; x=3  -> republish OVERWRITES the foreign edit (B1=3):
                                                        Python-owned regions are OUTPUTS, not bidir
    E  x=8; qb.undo(); u=1; y=x                      -> R7: undo reverts the grid (B1!=live x) ->
                                                        force_check is "NEXT TOUCHED var": an unrelated
                                                        `u=1` does NOT overfire; `y=x` heals C1=16 via a
                                                        same-epoch INCREMENTAL delta (fingerprint unchanged)
    F  vec=[10,20,30]; qb.publish(...)              -> D3 (=A3+B3+C3) = 60
    G  vec[1]=99                                     -> mutate-in-place (1b) -> D3 = 10+99+30 = 139

  The Codex CATCH -- DataFrame dynamic-shape blank-fill (the centerpiece), proven ADVERSARIALLY:
    H  df=DataFrame([[10,20,30]]); publish to A5:C5  -> D5 (=A5+B5+C5) = 60
       df=DataFrame([[1,2]])  (SHRINKS)              -> qb blank-fills the vacated C5 (literally BLANK) -> D5=3
       CONTROL (naive publish_dataset, no blank-fill, parallel A7:C7) -> D7 = 1+2+30 = 33 (STALE!)
       => 3 (guarded) vs 33 (naive) proves blank-fill is LOAD-BEARING, not vacuous.
    N  arr=np.array([1,2,3]); publish; arr=[4,5,6]  -> D12 6->15 (numeric ndarray path); same-value quiet;
                                                        object-dtype publish REJECTED (tobytes pointer-hash trap)
    S  del arr; def f(): return arr                  -> arr touched but GONE -> marked STALE + surfaced
                                                        (not silently skipped); cold A12 remains (v1 cut)

  v1 fail-loud guards (plan §13.3) -- each REJECTED loudly, then the escape hatch accepted:
    G1 duplicate name      -> reject; same owner_cell re-run OK (idempotent run-all); replace=True OK
    G2 overlapping envelope -> reject (two published regions may not collide)
    G3 target over a FORMULA -> reject; overwrite=True OK (never silently clobber a user formula)

  HIGH (Codex fold): every incremental publish/hook path asserts NOT fullRebuildRequired -- a stale /
  epoch-mismatched cursor (verified live to occur on a pre-undo token) fails LOUD in
  _recalc_and_snapshot, so a regressed undo-resync cannot silently heal ground while masking a full rebuild.

Engine facts this rests on (verified in ql-exec/src/session.rs):
  - publish_dataset writes PERSISTENT cells (write_range -> BatchCommit, op-logged) and on a SHRINK
    re-publish it dirties the vacated dependents but LEAVES the vacated VALUES in place
    (`publish_dataset_republish_shrink_dirties_vacated_dependents`: "clearing is the caller's job")
    -> hence fixed-envelope blank-fill in the GLUE.
  - a JSON `null` value publishes as a Blank cell (`publish_dataset_null_is_blank`) -> the blank-fill.
  - publish_dataset is ONE BatchCommit; a single undo reverts it (`..._is_one_batch_commit_and_undo_reverts`).
  - `cell()` returns None for blank, or a dict with a `formula` key for a formula cell -> the G3 guard.

Run (Mac host, isolated venv; needs pandas+numpy for the real DataFrame leg):
  "$HOME/.fe15-spike-venv/bin/python" crates/quantbook-py/tests/reactive_kernel_publish_pyo3.py

KNOWN LIMITATIONS (deliberately out of scope; named v1 CUTS / later units, plan §13.6):
  - range-follows-cells on row/col insert/move: the envelope is ABSOLUTE coords (a value that grows
    past the fixed envelope is rejected loudly, never silently truncated).
  - bidirectional (a sheet edit flowing back to the Python namespace): NOT built; published cells are
    outputs (leg D).
  - unpublish / `del df`-clears-grid: NOT built (registry marks stale; cold cells remain).
  - serialization FIDELITY (R3): numeric frames only here; NaN/datetime/categorical/MultiIndex dtype
    round-trip is the Arrow v1.1 path, not this binding spike.
  - the 1b detector's alias-mutation false-negative (`y=vec; y[0]=5`) and flat-binds-only scoping
    (marimo ScopedVisitor upgrade) carry forward unchanged.
"""

import ast
import json
import shutil
import sys
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve()
_WORKSPACE_ROOT = _HERE.parents[3]  # crates/quantbook-py/tests -> root


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
    print(f"[reactive-kernel-publish-pyo3] loading extension: {cdylib}", file=sys.stderr)
    staging = Path(tempfile.mkdtemp(prefix="qbpy_reactive_pub_"))
    target = staging / "_quantbook.so"
    shutil.copy2(cdylib, target)
    sys.path.insert(0, str(staging))
    import _quantbook  # noqa: E402
    return _quantbook


# ---------------------------------------------------------------------------
# FE-1.5-1b change-detector (carried forward unchanged): cell source -> (defs, refs)
# ---------------------------------------------------------------------------
def _assign_target_names(target):
    """Names BOUND by an assignment target. Subscript/Attribute targets bind NO name
    (mutate-in-place of an existing object) -> deliberately excluded."""
    out = []
    if isinstance(target, ast.Name) and isinstance(target.ctx, ast.Store):
        out.append(target.id)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for e in target.elts:
            out.extend(_assign_target_names(e))
    elif isinstance(target, ast.Starred):
        out.extend(_assign_target_names(target.value))
    return out


def cell_defs_refs(code):
    """(defs, refs) for a cell: top-level bound names + all Load-context names. Flat binds only;
    the marimo ScopedVisitor is the documented scoping upgrade (carried from FE-1.5-1b)."""
    tree = ast.parse(code)
    defs = set()
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign):
            for t in stmt.targets:
                defs.update(_assign_target_names(t))
        elif isinstance(stmt, ast.AugAssign):
            defs.update(_assign_target_names(stmt.target))
        elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
            defs.update(_assign_target_names(stmt.target))
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defs.add(stmt.name)
        elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
            for alias in stmt.names:
                defs.add((alias.asname or alias.name).split(".")[0])
    refs = {n.id for n in ast.walk(tree)
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    return defs, refs


# ---------------------------------------------------------------------------
# Value <-> grid: fingerprint (change-detect), matrix (serialize), blank-fill (the §13.3 catch)
# ---------------------------------------------------------------------------
def _is_dataframe(v):
    return type(v).__module__.startswith("pandas") and type(v).__name__ == "DataFrame"


def _is_ndarray(v):
    return type(v).__module__.startswith("numpy") and type(v).__name__ == "ndarray"


def _fingerprint(v):
    """A hashable value fingerprint (replaces `==`; works for ndarray/DataFrame where `==` is
    elementwise). Changes iff the published value changes -- the auto-republish trigger."""
    if isinstance(v, bool):
        return ("bool", v)
    if isinstance(v, (int, float)):
        return ("num", v)
    if isinstance(v, str):
        return ("str", v)
    if _is_dataframe(v):
        import pandas as pd
        # hash_pandas_object handles mixed dtypes; pair it with shape+columns so a reshape or a
        # rename is also a change. (NaN/datetime fidelity is R3, not this binding question.)
        h = pd.util.hash_pandas_object(v, index=True).values.tobytes()
        return ("df", tuple(v.shape), tuple(str(c) for c in v.columns), h)
    if _is_ndarray(v):
        # MED-3 (Codex fold): `tobytes()` on an object-dtype array hashes POINTER identities, not
        # values -- two value-equal object arrays would look "changed" (or worse, alias-equal ones
        # look unchanged). Reject object dtype loudly; numeric dtypes round-trip byte-for-byte by
        # value, matching the matrix `_to_matrix` actually publishes.
        if v.dtype == object:
            raise PublishError(
                "object-dtype ndarray cannot be value-fingerprinted (tobytes hashes pointers); "
                "publish a numeric ndarray, or a list / DataFrame"
            )
        return ("ndarray", tuple(v.shape), str(v.dtype), v.tobytes())
    if isinstance(v, (list, tuple)):
        return ("seq", tuple(_fingerprint(e) for e in v))
    raise PublishError(f"unsupported published value type: {type(v)!r}")


def _to_matrix(v):
    """Published value -> a row-major list-of-lists of NATIVE python scalars (so json.dumps is
    lossless; a stray numpy scalar would raise in json.dumps -> fail-loud, no silent coercion).
    scalar -> 1x1; 1-D list/ndarray -> a single 1xN row; DataFrame/2-D ndarray -> its 2-D values."""
    if isinstance(v, bool):
        return [[bool(v)]]
    if isinstance(v, (int, float, str)):
        return [[v]]
    if _is_dataframe(v):
        return v.to_numpy().tolist()  # native python scalars (object/float/int)
    if _is_ndarray(v):
        lst = v.tolist()
        if v.ndim == 1:
            return [list(lst)]
        if v.ndim == 2:
            return [list(row) for row in lst]
        raise PublishError(f"only 1-D/2-D ndarray publish; got ndim={v.ndim}")
    if isinstance(v, (list, tuple)):
        if v and isinstance(v[0], (list, tuple)):  # 2-D nested
            return [list(row) for row in v]
        return [[(bool(e) if isinstance(e, bool) else e) for e in v]]  # 1-D -> one row
    raise PublishError(f"unsupported published value type: {type(v)!r}")


def _blank_fill(matrix, env_rows, env_cols):
    """Pad the value matrix to the FIXED ENVELOPE with None (-> JSON null -> Blank cell). This is
    the §13.3 / Codex fix: a SHRUNK value would otherwise leave the engine's vacated cells holding
    STALE old values (engine: "clearing is the caller's job"), so dependents would recompute against
    them. Publishing the FULL envelope every time, blank-filling the unused cells, prevents that.
    A value LARGER than the fixed envelope is a loud reject (range-follows-cells is a v1 cut)."""
    nr = len(matrix)
    nc = len(matrix[0]) if matrix else 0
    for row in matrix:
        if len(row) != nc:
            raise PublishError(f"non-rectangular value matrix: row widths differ ({nc} vs {len(row)})")
    if nr > env_rows or nc > env_cols:
        raise PublishError(
            f"value {nr}x{nc} exceeds its fixed envelope {env_rows}x{env_cols} "
            f"(range-follows-cells is a v1 cut; publish to a larger target or re-register with replace=True)"
        )
    out = [[None] * env_cols for _ in range(env_rows)]
    for r in range(nr):
        for c in range(nc):
            out[r][c] = matrix[r][c]
    return out


# ---------------------------------------------------------------------------
# A1 target parsing  ("Bench!A1:C3" / "Bench!B1")  -> engine CellRange dict
# ---------------------------------------------------------------------------
def _a1_cell(ref):
    """'B12' -> (row=11, col=1) 0-indexed. Loud reject on a malformed ref."""
    i = 0
    while i < len(ref) and ref[i].isalpha():
        i += 1
    letters, digits = ref[:i], ref[i:]
    if not letters or not digits or not digits.isdigit():
        raise PublishError(f"malformed A1 cell reference: {ref!r}")
    row1 = int(digits)
    if row1 < 1:  # LOW-1 (Codex fold): reject 'A0' here (as a PublishError), not as a later engine
        raise PublishError(f"A1 row number must be >= 1: {ref!r}")  # negative-index reject downstream
    col = 0
    for ch in letters.upper():
        col = col * 26 + (ord(ch) - ord("A") + 1)
    return row1 - 1, col - 1


class PublishError(RuntimeError):
    """A loud, caller-facing binding rejection (No-Fallbacks: never swallow / default)."""


_SENTINEL = object()


class Quantbook:
    """The `qb` the notebook author calls. Owns the kernel-memory name->target/fingerprint registry,
    serializes + blank-fills published values, and is the SOLE engine writer. The post_run_cell hook
    auto-republishes any registered var whose AST-touch ∩ registry value-fingerprint changed (or that
    is force_check'd after an epoch change). No fallbacks: every failure raises and is re-surfaced."""

    def __init__(self, session, shell, version):
        self._s = session
        self._shell = shell
        self._version = version            # the snapshot_delta cursor (bytes)
        self._reg = {}                     # name -> binding record
        self.events = []                   # cleared per-cell by the driver; {"kind": "publish"|"hook", ...}
        self._hook_error = None

    @property
    def version(self):
        return self._version

    # ---- target resolution -------------------------------------------------
    def _sheet_id(self, name):
        for sh in self._s.list_sheets():
            if sh["name"] == name:
                return float(sh["id"])
        raise PublishError(f"unknown sheet {name!r} in publish target")

    def _parse_target(self, a1):
        sheet_name, sep, ref = a1.partition("!")
        if not sep:
            raise PublishError(f"target must be sheet-qualified, e.g. 'Bench!A1:C3'; got {a1!r}")
        sheet = self._sheet_id(sheet_name)
        if ":" in ref:
            a, b = ref.split(":", 1)
            r0, c0 = _a1_cell(a)
            r1, c1 = _a1_cell(b)
        else:
            r0, c0 = _a1_cell(ref)
            r1, c1 = r0, c0
        if r1 < r0 or c1 < c0:
            raise PublishError(f"target range end is before its start: {a1!r}")
        return {"sheet": sheet, "startRow": r0, "startCol": c0, "endRow": r1, "endCol": c1}

    @staticmethod
    def _envelope_cells(rng):
        return {(r, c)
                for r in range(rng["startRow"], rng["endRow"] + 1)
                for c in range(rng["startCol"], rng["endCol"] + 1)}

    # ---- the user-facing API ----------------------------------------------
    def publish(self, name, value, target, *, owner_cell_id=None, replace=False, overwrite=False):
        """Register name->target and write `value` now. Fail-loud guards (plan §13.3):
          - duplicate name (unless the SAME owner_cell re-runs, or replace=True);
          - the envelope overlaps another published region;
          - the envelope covers a pre-existing user FORMULA (unless overwrite=True);
          - replace may NOT move the target (range-follows-cells is a v1 cut)."""
        rng = self._parse_target(target)
        env_rows = rng["endRow"] - rng["startRow"] + 1
        env_cols = rng["endCol"] - rng["startCol"] + 1
        env_cells = self._envelope_cells(rng)
        sheet = rng["sheet"]

        # GUARD 1 -- duplicate name.
        if name in self._reg:
            prev = self._reg[name]
            same_owner = owner_cell_id is not None and prev["owner_cell_id"] == owner_cell_id
            if not (replace or same_owner):
                raise PublishError(
                    f"name {name!r} is already published (owner {prev['owner_cell_id']!r}); "
                    f"re-run from the owning cell, or pass replace=True"
                )
            if (replace or same_owner) and prev["range"] != rng:
                raise PublishError(
                    f"cannot move published {name!r} from {prev['range']} to {rng} "
                    f"(range-follows-cells is a v1 cut)"
                )

        # GUARD 2 -- overlap with another published region's envelope.
        for other, rec in self._reg.items():
            if other == name:
                continue
            if rec["range"]["sheet"] == sheet and (env_cells & rec["cells"]):
                raise PublishError(
                    f"publish target for {name!r} overlaps the published region {other!r}"
                )

        # GUARD 3 -- target covers a pre-existing user FORMULA (published cells are values, never
        # formulas, so any formula in the envelope is a hand-authored one we must not silently clobber).
        if not overwrite:
            for (r, c) in sorted(env_cells):
                cell = self._s.cell(sheet, float(r), float(c))
                if cell is not None and "formula" in cell:
                    raise PublishError(
                        f"publish target for {name!r} would overwrite the formula at "
                        f"(row={r},col={c}): {cell['formula']!r}; pass overwrite=True to replace it"
                    )

        # Fingerprint BEFORE any write (validate-before-mutate; an unsupported/object-dtype value must
        # reject WITHOUT having partially written the grid -- mirrors the engine's "loud bad_argument
        # before any mutation" discipline).
        fp = _fingerprint(value)
        self._write(name, value, rng, env_rows, env_cols)
        self._reg[name] = {
            "range": rng, "cells": env_cells, "env_rows": env_rows, "env_cols": env_cols,
            "fp": fp, "owner_cell_id": owner_cell_id,
            "force_check": False, "stale": False,
        }
        delta = self._recalc_and_snapshot()
        self.events.append({"kind": "publish", "name": name,
                            "delta_changed": delta["changedCells"],
                            "full_rebuild": delta["fullRebuildRequired"],
                            "version_after": self._version})
        return delta

    def _write(self, name, value, rng, env_rows, env_cols):
        filled = _blank_fill(_to_matrix(value), env_rows, env_cols)
        self._s.publish_dataset(name, json.dumps({"values": filled}), rng)

    def _recalc_and_snapshot(self):
        self._s.recalc_dirty()
        delta = self._s.snapshot_delta(self._version)
        # HIGH (Codex fold): every publish/hook path in this binding is INCREMENTAL (the cursor is
        # threaded across publish, hook, undo-resync, and foreign-edit). A fullRebuildRequired here
        # means the cursor went stale / epoch-mismatched (engine session.rs:2778, 1099) -- which would
        # SILENTLY mask a missing reactive recompute (a delta_changed that came from a full rebuild,
        # not from the republish). Fail LOUD instead of trusting such a delta. This is the single
        # most-important guard: a stale cursor after undo (R7) is now impossible to miss.
        if delta["fullRebuildRequired"]:
            raise PublishError(
                "snapshot_delta required a FULL REBUILD (stale/epoch-mismatched cursor) -- the "
                "incremental reactive delta cannot be trusted; the cursor was not threaded correctly"
            )
        self._version = delta["version"]
        return delta

    # ---- epoch / undo: the R7 force_check signal --------------------------
    def on_epoch_change(self):
        """The host calls this when an undo/redo (or any non-publish epoch transition) changes the
        grid out from under the registry. It marks every binding force_check so the NEXT touch of a
        published var republishes it even if its python value is unchanged -- healing a grid that an
        undo reverted away from the live namespace (plan §13.3 / R7)."""
        for rec in self._reg.values():
            rec["force_check"] = True

    def undo(self):
        """Spike convenience: the host owns undo, so the entity that performs the undo is the entity
        that signals the epoch change. Mirrors host wiring: s.undo() -> recalc -> resync cursor ->
        force_check. (In 1c/1d the host detects the epoch and calls on_epoch_change directly.)"""
        self._s.undo()
        self._s.recalc_dirty()
        self._version = self._s.snapshot()["version"]   # resync past the epoch (avoid epoch_mismatch)
        self.on_epoch_change()

    # ---- the auto-republish hook (post_run_cell) --------------------------
    def on_post_run_cell(self, result):
        try:
            version_before = self._version
            src = result.info.raw_cell if getattr(result, "info", None) is not None else ""
            defs, refs = cell_defs_refs(src)
            # MED-1 (Codex fold): the decided contract (plan §13.3) is "the NEXT TOUCHED published var
            # republishes". So the candidate set is exactly the AST-touched registered vars -- NOT every
            # force_check'd binding. A force_check'd-but-UNTOUCHED var stays pending until a cell touches
            # it (so an unrelated `u = 1` after an undo does NOT rewrite every Python-owned output).
            # force_check only changes the *decision* for a touched var (republish despite an unchanged
            # fingerprint), it does not widen the candidate set.
            touched = (defs | refs) & set(self._reg)
            candidates = sorted(touched)
            republished, forced_fire, stale = [], [], []
            for name in candidates:
                rec = self._reg[name]
                cur = self._shell.user_ns.get(name, _SENTINEL)
                if cur is _SENTINEL:
                    # MED-2 (Codex fold): a touched registered var that is GONE from the namespace
                    # (e.g. `del x`) is marked STALE and surfaced in the event -- never silently
                    # skipped. This honestly implements the §13.4 "mark the binding stale/missing"
                    # claim (full unpublish/clear-the-grid is a named v1 cut); No-Fallbacks =
                    # the state is visible, not hidden.
                    rec["stale"] = True
                    stale.append(name)
                    continue
                fp = _fingerprint(cur)
                changed = fp != rec["fp"]
                if not changed and not rec["force_check"]:
                    continue
                if not changed and rec["force_check"]:
                    forced_fire.append(name)  # republishing a value the engine reverted under us
                self._write(name, cur, rec["range"], rec["env_rows"], rec["env_cols"])
                rec["fp"] = fp
                rec["force_check"] = False
                rec["stale"] = False
                republished.append(name)
            delta = []
            full_rebuild = False
            if republished:
                d = self._recalc_and_snapshot()
                delta = d["changedCells"]
                full_rebuild = d["fullRebuildRequired"]
            self.events.append({"kind": "hook", "defs": sorted(defs),
                                "refs_touched": sorted(touched), "republished": republished,
                                "forced": forced_fire, "stale": stale, "delta_changed": delta,
                                "full_rebuild": full_rebuild,
                                "version_before": version_before, "version_after": self._version})
        except BaseException as exc:  # noqa: BLE001 -- record then re-raise loudly in the driver
            self._hook_error = exc
            raise

    def raise_if_errored(self):
        if self._hook_error is not None:
            raise SystemExit(f"[reactive-kernel-publish-pyo3] glue error in hook: {self._hook_error!r}")


# ---------------------------------------------------------------------------
# delta / cell helpers
# ---------------------------------------------------------------------------
def _find_cell(changed, row, col):
    for cc in changed:
        c = cc.get("cell")
        if c and c.get("row") == row and c.get("col") == col:
            return c
    return None


def _num(cell):
    v = cell.get("value") if cell else None
    return v.get("number") if v else None


def main():
    qb_ext = _load_quantbook()
    s = qb_ext.Session()
    sheet = s.add_sheet("Bench", 1000)

    # Dependent formulas (the FE-1.5-0 shape). Addresses 0-indexed (row, col).
    s.set_formula(sheet, 0, 2, "B1*2")          # C1  = B1*2          (scalar x leg)
    s.set_formula(sheet, 2, 3, "A3+B3+C3")      # D3  = A3+B3+C3      (vector leg)
    s.set_formula(sheet, 4, 3, "A5+B5+C5")      # D5  = A5+B5+C5      (DataFrame blank-fill leg)
    s.set_formula(sheet, 6, 3, "A7+B7+C7")      # D7  = A7+B7+C7      (naive CONTROL leg)
    s.set_formula(sheet, 4, 5, "1+1")           # F5  = 1+1           (G3 formula-overwrite target)
    s.set_formula(sheet, 11, 3, "A12+B12+C12")  # D12 = A12+B12+C12   (ndarray leg)
    s.recalc_dirty()
    version = s.snapshot()["version"]

    from IPython.core.interactiveshell import InteractiveShell
    shell = InteractiveShell.instance()

    qb = Quantbook(s, shell, version)
    shell.user_ns["qb"] = qb
    shell.events.register("post_run_cell", qb.on_post_run_cell)

    def run(code):
        qb.events.clear()
        res = shell.run_cell(code, store_history=False)
        if res.error_in_exec is not None:
            raise SystemExit(f"[reactive-kernel-publish-pyo3] cell raised: {code!r} -> {res.error_in_exec!r}")
        qb.raise_if_errored()
        return list(qb.events)

    def hook_ev(evs):
        hooks = [e for e in evs if e["kind"] == "hook"]
        if len(hooks) != 1:
            raise SystemExit(f"[reactive-kernel-publish-pyo3] expected exactly 1 hook event, got {len(hooks)}")
        return hooks[0]

    def delta_in(evs, row, col):
        """The numeric value of (row,col) found in ANY of this cell's deltas (reactive proof)."""
        for e in evs:
            c = _find_cell(e["delta_changed"], row, col)
            if c is not None:
                return _num(c)
        return None

    def ground(row, col):
        return _num(s.cell(sheet, float(row), float(col)))

    def is_blank(row, col):
        """LOW-2: a genuinely Blank cell -- s.cell() returns None, or a dict with NO value (the
        engine clears it). Distinct from `ground()==None`, which also matches text/bool/error."""
        c = s.cell(sheet, float(row), float(col))
        if c is None:
            return True
        v = c.get("value")
        return v is None or v.get("kind") == "blank"

    def expect_reject(fn, label):
        try:
            fn()
        except PublishError as exc:
            return exc
        raise SystemExit(f"[reactive-kernel-publish-pyo3] {label} invalid: expected a PublishError reject, none raised")

    # =========================================================================
    # B -- first publish writes the cell; the SAME-cell hook is QUIET (no double-fire).
    # =========================================================================
    evs = run('x = 0\n_pub = qb.publish("x", x, "Bench!B1", owner_cell_id="cellX")')
    if ground(0, 1) != 0:
        raise SystemExit(f"B invalid: B1 expected 0, got {ground(0,1)}")
    h = hook_ev(evs)
    if "x" not in h["refs_touched"]:
        raise SystemExit(f"B invalid: x must be a touched candidate (proves quiet = fingerprint-suppressed, not unseen), got {h['refs_touched']}")
    if h["republished"]:
        raise SystemExit(f"B invalid: explicit publish + hook DOUBLE-fired (hook republished {h['republished']})")

    # =========================================================================
    # C -- reassign x -> hook auto-republishes -> C1 reactively recomputes.
    # =========================================================================
    evs = run("x = 7")
    h = hook_ev(evs)
    if h["republished"] != ["x"]:
        raise SystemExit(f"C invalid: expected republish ['x'], got {h['republished']}")
    if delta_in(evs, 0, 2) != 14:
        raise SystemExit(f"C invalid: C1 expected 14 in delta, got {delta_in(evs,0,2)}")
    if ground(0, 1) != 7 or ground(0, 2) != 14:
        raise SystemExit(f"C invalid: ground B1/C1 expected 7/14, got {ground(0,1)}/{ground(0,2)}")

    # =========================================================================
    # D -- a foreign hand-edit of a published cell is OVERWRITTEN on republish
    #      (Python-owned regions are OUTPUTS, not bidirectional).
    # =========================================================================
    s.set_value(sheet, 0, 1, {"kind": "number", "number": 999})   # the user types 999 into B1 directly
    s.recalc_dirty()
    if ground(0, 1) != 999:
        raise SystemExit(f"D setup invalid: B1 expected 999 after hand-edit, got {ground(0,1)}")
    qb._version = s.snapshot()["version"]  # host would resync the cursor after a user edit
    evs = run("x = 3")
    if hook_ev(evs)["republished"] != ["x"]:
        raise SystemExit(f"D invalid: expected republish ['x'], got {hook_ev(evs)['republished']}")
    if ground(0, 1) != 3:
        raise SystemExit(f"D invalid: foreign edit not overwritten -- B1 expected 3, got {ground(0,1)}")

    # =========================================================================
    # E -- R7: undo reverts the grid away from the live var; force_check-on-epoch
    #      republishes on the NEXT touch DESPITE an unchanged fingerprint -> heals.
    # =========================================================================
    evs = run("x = 8")                       # B1=8, C1=16 (one publish batch)
    if ground(0, 1) != 8 or ground(0, 2) != 16:
        raise SystemExit(f"E setup invalid: B1/C1 expected 8/16, got {ground(0,1)}/{ground(0,2)}")
    qb.undo()                                # reverts the x=8 publish; live x stays 8; marks force_check
    if ground(0, 1) == 8:
        raise SystemExit(f"E invalid: undo did not revert B1 away from the live var (still {ground(0,1)})")
    b1_reverted = ground(0, 1)

    # MED-1: an UNRELATED cell after the undo must NOT republish x (force_check is "next TOUCHED var",
    # not "next cell rewrites every Python output"). x must stay force_check'd + unhealed.
    evs = run("u = 1")
    h = hook_ev(evs)
    if h["republished"] or "x" in h["refs_touched"]:
        raise SystemExit(f"E invalid (overfire): unrelated cell republished {h['republished']} (refs={h['refs_touched']})")
    if not qb._reg["x"]["force_check"]:
        raise SystemExit("E invalid: an untouched cell consumed x's force_check (must persist until x is touched)")
    if ground(0, 1) == 8:
        raise SystemExit("E invalid: an unrelated cell healed the grid (force_check over-fired)")

    evs = run("y = x")                        # x touched (ref) but value UNCHANGED (still 8)
    h = hook_ev(evs)
    if h["forced"] != ["x"] or h["republished"] != ["x"]:
        raise SystemExit(f"E invalid: expected forced+republish ['x'] (fingerprint unchanged), got forced={h['forced']} republished={h['republished']}")
    # HIGH (Codex fold): the heal must arrive via a SAME-EPOCH INCREMENTAL delta carrying C1=16 -- NOT
    # merely via ground state (a regressed cursor-resync would still fix ground but force a full rebuild,
    # which _recalc_and_snapshot now rejects loudly; here we ALSO assert the incremental delta itself).
    if h["full_rebuild"]:
        raise SystemExit("E invalid: heal required a full rebuild (stale cursor) -- not a clean incremental delta")
    if delta_in(evs, 0, 2) != 16:
        raise SystemExit(f"E invalid: heal delta must carry C1=16 incrementally, got {delta_in(evs,0,2)}")
    if ground(0, 1) != 8 or ground(0, 2) != 16:
        raise SystemExit(f"E invalid: force_check did not heal grid -- B1/C1 expected 8/16 (was {b1_reverted}), got {ground(0,1)}/{ground(0,2)}")
    if qb._reg["x"]["force_check"]:
        raise SystemExit("E invalid: force_check must clear after the heal")
    evs = run("z = x")                        # force_check cleared -> a same-value touch is QUIET again
    if hook_ev(evs)["republished"]:
        raise SystemExit(f"E invalid: force_check did not clear -- a same-value touch republished {hook_ev(evs)['republished']}")

    # =========================================================================
    # F/G -- vector publish + mutate-in-place (1b) flow through the binding.
    # =========================================================================
    evs = run('vec = [10, 20, 30]\n_pub = qb.publish("vec", vec, "Bench!A3:C3", owner_cell_id="cellV")')
    if ground(2, 3) != 60:
        raise SystemExit(f"F invalid: D3 expected 60, got {ground(2,3)}")
    evs = run("vec[1] = 99")                  # mutate-in-place: defs empty, vec a ref, fingerprint changed
    h = hook_ev(evs)
    if h["defs"] != [] or h["republished"] != ["vec"]:
        raise SystemExit(f"G invalid: expected defs [] + republish ['vec'], got defs={h['defs']} republished={h['republished']}")
    if delta_in(evs, 2, 3) != 139 or ground(2, 3) != 139:
        raise SystemExit(f"G invalid: D3 expected 139 (10+99+30), got delta={delta_in(evs,2,3)} ground={ground(2,3)}")

    # =========================================================================
    # H -- the Codex catch: DataFrame SHRINK blank-fill, proven ADVERSARIALLY vs a naive control.
    # =========================================================================
    run("import pandas as pd")
    evs = run('df = pd.DataFrame([[10.0, 20.0, 30.0]])\n_pub = qb.publish("df", df, "Bench!A5:C5", owner_cell_id="cellDF")')
    if ground(4, 3) != 60:
        raise SystemExit(f"H invalid: D5 expected 60, got {ground(4,3)}")
    evs = run("df = pd.DataFrame([[1.0, 2.0]])")   # SHRINKS 1x3 -> 1x2; hook auto-republishes df
    h = hook_ev(evs)
    if h["republished"] != ["df"]:
        raise SystemExit(f"H invalid: expected republish ['df'], got {h['republished']}")
    if delta_in(evs, 4, 3) != 3 or ground(4, 3) != 3:
        raise SystemExit(f"H invalid (blank-fill): D5 expected 3 (1+2+blank), got delta={delta_in(evs,4,3)} ground={ground(4,3)}")
    if not is_blank(4, 2):   # LOW-2: literally Blank, not merely "not a number"
        raise SystemExit(f"H invalid: C5 expected a BLANK cell after shrink, got {s.cell(sheet, 4.0, 2.0)}")

    # =========================================================================
    # N -- numpy ndarray publish + reassign (MED-3): the ndarray serialize/fingerprint path, proven
    #      (was previously dead code); plus object-dtype is rejected loudly (pointer-hash trap).
    # =========================================================================
    run("import numpy as np")
    evs = run('arr = np.array([1.0, 2.0, 3.0])\n_pub = qb.publish("arr", arr, "Bench!A12:C12", owner_cell_id="cellArr")')
    if ground(11, 3) != 6:
        raise SystemExit(f"N invalid: D12 expected 6, got {ground(11,3)}")
    evs = run("arr = np.array([4.0, 5.0, 6.0])")   # reassign -> fingerprint (numeric tobytes) changes
    h = hook_ev(evs)
    if h["republished"] != ["arr"]:
        raise SystemExit(f"N invalid: expected republish ['arr'], got {h['republished']}")
    if delta_in(evs, 11, 3) != 15 or ground(11, 3) != 15:
        raise SystemExit(f"N invalid: D12 expected 15 (4+5+6), got delta={delta_in(evs,11,3)} ground={ground(11,3)}")
    # an UNCHANGED-value reassign of the same numeric array is engine-quiet (value-semantic fingerprint).
    evs = run("arr = np.array([4.0, 5.0, 6.0])")
    if hook_ev(evs)["republished"]:
        raise SystemExit(f"N invalid: same-value ndarray reassign must be quiet, got {hook_ev(evs)['republished']}")
    # object-dtype publish is rejected loudly (the tobytes pointer-hash trap).
    expect_reject(lambda: qb.publish("objarr", __import__("numpy").array([1, "a"], dtype=object),
                                     "Bench!A13:B13", owner_cell_id="cellObj"), "N-object-dtype")

    # =========================================================================
    # S -- registered-but-MISSING var is marked STALE + surfaced (MED-2), never silently skipped.
    #      `del arr` (AST Delete -> not touched, quiet); then a cell that REFERENCES arr in a body
    #      that is not executed (so no NameError) makes arr a touched candidate while it is GONE.
    # =========================================================================
    run("del arr")                                  # arr removed from the namespace (a v1 gap, not a crash)
    evs = run("def _uses_arr():\n    return arr")    # AST ref 'arr' (touched), but arr is GONE from user_ns
    h = hook_ev(evs)
    if "arr" not in h["refs_touched"]:
        raise SystemExit(f"S invalid: arr must be a touched candidate, got {h['refs_touched']}")
    if h["stale"] != ["arr"] or h["republished"]:
        raise SystemExit(f"S invalid: missing arr must be marked STALE (not silently skipped), got stale={h['stale']} republished={h['republished']}")
    if not qb._reg["arr"]["stale"]:
        raise SystemExit("S invalid: registry record for arr must carry stale=True")
    if ground(11, 0) != 4:   # cold cells REMAIN (clear-on-del is a named v1 cut) -- A12 still 4
        raise SystemExit(f"S invalid: cold published cells must remain after del (A12 expected 4), got {ground(11,0)}")

    # CONTROL: the SAME shrink via a naive publish_dataset (no blank-fill) leaves C7 stale -> D7=33.
    A7C7 = {"sheet": sheet, "startRow": 6, "startCol": 0, "endRow": 6, "endCol": 2}
    s.publish_dataset("ctrl", json.dumps({"values": [[10.0, 20.0, 30.0]]}), A7C7)
    s.recalc_dirty()
    if ground(6, 3) != 60:
        raise SystemExit(f"H control setup invalid: D7 expected 60, got {ground(6,3)}")
    s.publish_dataset("ctrl", json.dumps({"values": [[1.0, 2.0]]}), A7C7)  # naive: writes A7,B7; C7 STALE
    s.recalc_dirty()
    if ground(6, 3) != 33:
        raise SystemExit(f"H control invalid: naive publish should leave D7=33 (stale C7=30), got {ground(6,3)}")
    # 3 (qb blank-fill) vs 33 (naive) => blank-fill is LOAD-BEARING.

    # =========================================================================
    # G1/G2/G3 -- the fail-loud guards (rejected loudly, then the escape hatch accepted).
    # =========================================================================
    # G1 duplicate name.
    qb.publish("dup", 5, "Bench!E1", owner_cell_id="cellDup")
    if ground(0, 4) != 5:
        raise SystemExit(f"G1 setup invalid: E1 expected 5, got {ground(0,4)}")
    expect_reject(lambda: qb.publish("dup", 9, "Bench!E1", owner_cell_id="other"), "G1-duplicate")
    qb.publish("dup", 6, "Bench!E1", owner_cell_id="cellDup")   # same owner re-run -> OK (idempotent)
    if ground(0, 4) != 6:
        raise SystemExit(f"G1 invalid: same-owner re-run should update E1 to 6, got {ground(0,4)}")
    qb.publish("dup", 7, "Bench!E1", owner_cell_id="other", replace=True)  # replace -> OK
    if ground(0, 4) != 7:
        raise SystemExit(f"G1 invalid: replace=True should update E1 to 7, got {ground(0,4)}")
    expect_reject(lambda: qb.publish("dup", 1, "Bench!F1", owner_cell_id="cellDup", replace=True), "G1-move")

    # G2 overlapping envelope.
    qb.publish("rangeA", [1, 2, 3], "Bench!A10:C10", owner_cell_id="cellA")
    expect_reject(lambda: qb.publish("rangeB", [9, 9], "Bench!B10:C10", owner_cell_id="cellB"), "G2-overlap")

    # G3 target over a pre-existing user FORMULA (F5 = 1+1).
    expect_reject(lambda: qb.publish("clob", 0, "Bench!F5", owner_cell_id="cellF"), "G3-formula")
    qb.publish("clob", 0, "Bench!F5", owner_cell_id="cellF", overwrite=True)   # overwrite -> OK
    if ground(4, 5) != 0:
        raise SystemExit(f"G3 invalid: overwrite=True should replace F5 with 0, got {ground(4,5)}")

    # G4 malformed A1 targets reject as a PublishError BEFORE any write (LOW-1 fold + re-audit:
    # exercise it, not just implement it). Row 0 and an unqualified ref both reject loudly.
    expect_reject(lambda: qb.publish("badrow", 1, "Bench!A0", owner_cell_id="cellBR"), "G4-row-zero")
    expect_reject(lambda: qb.publish("badq", 1, "A1", owner_cell_id="cellBQ"), "G4-unqualified")
    if "badrow" in qb._reg or "badq" in qb._reg:
        raise SystemExit("G4 invalid: a rejected malformed-target publish must not register the binding")

    print("[reactive-kernel-publish-pyo3] PASS -- qb.publish binding + registry + auto-republish + v1 guards")
    print("  B  publish x=0       -> B1=0; same-cell hook QUIET (no double publish)")
    print("  C  x=7               -> auto-republish -> C1=14")
    print("  D  hand-edit B1=999; x=3 -> republish OVERWRITES foreign edit -> B1=3 (outputs, not bidir)")
    print("  E  x=8; undo; u=1; y=x -> force_check is NEXT-TOUCHED (u=1 no overfire); y=x heals C1=16 incrementally")
    print("  F  publish vec       -> D3=60")
    print("  G  vec[1]=99         -> mutate-in-place -> D3=139")
    print("  H  df 1x3->1x2 SHRINK -> blank-fill -> D5=3 + C5 literally BLANK  (naive control D7=33 STALE)")
    print("  N  np.array publish/reassign -> D12=6->15; same-value quiet; object-dtype REJECT")
    print("  S  del arr; ref arr  -> marked STALE + surfaced (not silently skipped); cold A12 remains")
    print("  G1 duplicate name    -> reject; same-owner re-run OK; replace OK; replace-move REJECT")
    print("  G2 overlapping range -> reject")
    print("  G3 over a formula    -> reject; overwrite=True OK")
    print("  G4 malformed A1 (row 0 / unqualified) -> reject before any write (no registry entry)")
    print("  HIGH-fold: every incremental delta asserts NOT fullRebuildRequired (stale cursor fails loud)")


if __name__ == "__main__":
    main()
