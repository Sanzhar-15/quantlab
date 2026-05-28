"""Process-local UDF registry shared by `register_formula_function` (in the
package ``__init__``) and the worker loop (`quantbook.worker`). Maps a `u64`
handle to a Python callable. 6.4-3b."""

_REGISTRY = {}


def register(handle, fn):
    _REGISTRY[int(handle)] = fn


def lookup(handle):
    return _REGISTRY.get(int(handle))


def clear():
    _REGISTRY.clear()
