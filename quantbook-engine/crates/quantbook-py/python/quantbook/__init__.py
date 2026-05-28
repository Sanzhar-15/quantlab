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


_U64_MAX = (1 << 64) - 1


def register_formula_function(fn, *, handle, name=None, replace=False):
    """Register ``fn`` as a Quantbook formula function under ``handle``.

    ``fn`` receives a :class:`quantbook.Grid` of evaluated arguments and returns a
    ``Grid`` or a scalar cell value (``float``/``int``/``bool``/``str``/``None``/
    :class:`quantbook.Err`). ``handle`` is an explicit ``u64`` for now (the IDE mints
    it at 6.4-3c/3d); ``name`` is informational. Returns ``handle``.

    Validates loudly (6.4-3b audit-fix: registry-silently-overwrites-invalid-handles;
    No-Fallbacks): ``fn`` must be callable, ``handle`` must fit ``u64``, and a duplicate
    ``handle`` is rejected unless ``replace=True`` — so a shipped handle can never silently
    route to the wrong callable or register a value the engine can never call.
    """
    if not callable(fn):
        raise TypeError(
            "register_formula_function: fn must be callable, got %r" % type(fn).__name__
        )
    h = int(handle)
    if not (0 <= h <= _U64_MAX):
        raise ValueError(
            "register_formula_function: handle %d out of u64 range [0, 2**64)" % h
        )
    _register(h, fn, replace=replace)
    return handle
