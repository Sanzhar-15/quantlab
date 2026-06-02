"""ENG-FUSION pyo3 smoke: publish_dataset + bind_range over the Python binding.

Loads the freshly-built cdylib the same way as golden_flow.py and proves the two new
wrappers: publish a value-matrix, bind a range, and the reactive
publish -> recalc -> dependent-recompute path (the moat) over PyO3. Run with a
py>=3.10 interpreter:

    cargo build -p quantbook-py
    python crates/quantbook-py/tests/eng_fusion_smoke.py
"""

import os
import shutil
import sys
import tempfile
from pathlib import Path


def _load():
    env = os.environ.get("QL_PY_CDYLIB")
    here = Path(__file__).resolve()
    workspace_root = here.parents[3]
    ext = "dylib" if sys.platform == "darwin" else "so"
    base = f"libquantbook_py.{ext}"
    cdylib = Path(env) if env else None
    if cdylib is None:
        for c in (
            workspace_root / "target" / "debug" / base,
            workspace_root / "target" / "release" / base,
        ):
            if c.exists():
                cdylib = c
                break
    if cdylib is None or not cdylib.exists():
        raise SystemExit("built cdylib not found; run `cargo build -p quantbook-py` first")
    staging = Path(tempfile.mkdtemp(prefix="qbpy_engfusion_"))
    shutil.copy2(cdylib, staging / "_quantbook.so")
    sys.path.insert(0, str(staging))
    import _quantbook  # noqa: E402

    return _quantbook


def main():
    qb = _load()
    QuantbookError = qb.QuantbookError
    s = qb.Session()
    sh = s.add_sheet("S", 16384)
    a21 = {"sheet": sh, "startRow": 20, "startCol": 0, "endRow": 20, "endCol": 0}

    # publish_dataset: a value-matrix writes A21=21 and echoes {id}.
    pub = s.publish_dataset("ds", '{"values":[[21]]}', a21)
    assert pub["id"] == "ds", pub

    # bind_range: registers the overlay region and echoes {bindingId}.
    b = s.bind_range("b1", a21)
    assert b["bindingId"] == "b1", b

    # Reactive (the moat): B21 = A21*2 depends on the published A21 (=21) -> 42 after recalc.
    s.set_formula(sh, 20, 1, "A21*2")
    s.recalc_dirty()
    cell = s.cell(sh, 20, 1)
    assert cell is not None and cell["value"]["number"] == 42.0, cell

    # malformed data is a loud bad_argument (No-Fallbacks), not a silent default.
    try:
        s.publish_dataset("ds", "not json", a21)
        raise SystemExit("publish_dataset accepted malformed data")
    except QuantbookError:
        pass

    print("[pyo3 eng-fusion smoke] PASS - publish/bind LIVE + reactive recompute over PyO3")


if __name__ == "__main__":
    main()
