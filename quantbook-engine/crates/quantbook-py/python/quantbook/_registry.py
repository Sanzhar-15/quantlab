"""Process-local UDF registry shared by `register_formula_function` (in the
package ``__init__``) and the worker loop (`quantbook.worker`). Maps a `u64`
handle to a Python callable. 6.4-3b."""

_REGISTRY = {}


def register(handle, fn, replace=False):
    """Map ``handle`` → ``fn``. Rejects a duplicate handle unless ``replace=True`` so a shipped
    handle can never SILENTLY route to a different callable (6.4-3b audit-fix:
    registry-silently-overwrites-invalid-handles; No-Fallbacks)."""
    h = int(handle)
    if not replace and h in _REGISTRY:
        raise ValueError(
            "UDF handle %d is already registered; pass replace=True to override" % h
        )
    _REGISTRY[h] = fn


def lookup(handle):
    return _REGISTRY.get(int(handle))


def clear():
    _REGISTRY.clear()
