"""Quantbook Python bindings.

**6.4-3b** ships the plain-Python **UDF worker** (`python -m quantbook.worker`) that
the Rust engine (`ql-udf::ProcessWorker`) drives over stdio — NO PyO3 in the hot
path. `register_formula_function` registers a Python callable as a formula function
the engine can invoke by handle.

The future PyO3 extension (`quantbook._quantbook`, the `qb.show`/`publish`/`bind`
authoring surface) is a SEPARATE, later concern (see `pyproject.toml`); it is not
required for the worker.
"""

from ._codec import Err, Grid  # noqa: F401  (re-exported for UDF authors)
from ._registry import lookup as _lookup  # noqa: F401  (used by quantbook.worker)
from ._registry import register as _register


def register_formula_function(fn, *, handle, name=None):
    """Register ``fn`` as a Quantbook formula function under ``handle``.

    ``fn`` receives a :class:`quantbook.Grid` of evaluated arguments and returns a
    ``Grid`` or a scalar cell value (``float``/``int``/``bool``/``str``/``None``/
    :class:`quantbook.Err`). ``handle`` is an explicit ``u64`` for now (the IDE mints
    it at 6.4-3c/3d); ``name`` is informational. Returns ``handle``.
    """
    _register(int(handle), fn)
    return handle
